// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

/**
 * http.ts — httpServe(httpServer, opts): mount a JSON-over-HTTP face on the
 * SAME ZAP service that serve() exposes over WebSocket.
 *
 * Motivation: external consumers (and the OpenAPI surface emitted by
 * `zapgen --emit=openapi`) speak POST /<service>/<method> with a JSON body.
 * httpServe terminates that HTTP shape and dispatches each request through the
 * identical {@link CallHandler} the WebSocket transport uses — so there is ONE
 * service implementation, reached two ways.
 *
 * The JSON⇄ZAP codec is schema-specific and therefore supplied by the caller as
 * a {@link HttpRoute} per method (the generated zapgen bindings know each
 * struct's shape; the runtime stays schema-agnostic — orthogonal separation).
 * Each route declares:
 *   - path:    POST path, matching the OpenAPI doc (`/document-service/...`).
 *   - method:  the .zap method ordinal (the same ordinal the WS client sends).
 *   - decode:  JSON request body  → ZAP payload bytes.
 *   - encode:  ZAP response body bytes → JSON value (omit for void methods).
 *
 * Auth runs per-request via the same {@link MintCap} slot serve() uses: a null
 * mint yields HTTP 401; a non-null mint becomes the `ctx` passed to rootCap,
 * whose {@link CallHandler} dispatches the decoded Call.
 *
 * Node `http` only — no framework. The HTTP server is supplied by the caller
 * (the same http.Server that serve() attaches its WebSocket upgrade to), so one
 * port serves WS + HTTP.
 */

import type {
  IncomingMessage,
  ServerResponse,
  Server as HttpServer,
} from "node:http";
import { NO_TARGET, Status, type Call, type Response } from "@zap-proto/zap";
import type { CallHandler } from "./conn.js";
import type { MintCap } from "./auth.js";
import type { RootCap } from "./server.js";

const EMPTY = new Uint8Array(0);
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB request-body ceiling.

/**
 * HttpRoute binds one POST path to one ZAP method, with the JSON⇄ZAP codec for
 * that method. `decode` turns the parsed JSON request body into the method's
 * ZAP payload bytes; `encode` turns the ZAP response body bytes into the JSON
 * value to serialize. A void method omits `encode` (returns HTTP 204).
 */
export interface HttpRoute {
  /** POST path, e.g. "/document-service/create-document". */
  path: string;
  /** The .zap method ordinal this path dispatches. */
  method: number;
  /** Parse a JSON request body into ZAP payload bytes. */
  decode: (json: unknown) => Uint8Array;
  /** Encode ZAP response body bytes into a JSON value. Omit for void methods. */
  encode?: (body: Uint8Array) => unknown;
}

/** Options for {@link httpServe}. */
export interface HttpServeOptions<Ctx> {
  /** The method routes (one per OpenAPI operation). */
  routes: HttpRoute[];
  /** Bearer→ctx boundary; return null to reject with HTTP 401. */
  mintCap: MintCap<Ctx>;
  /** Produce the dispatch handler for a minted ctx (same shape as serve()). */
  rootCap: RootCap<Ctx>;
  /**
   * Optional path prefix mounted before each route path, e.g. "/v1" makes the
   * route "/echo/echo" serve at "/v1/echo/echo". Default "" (no prefix).
   */
  prefix?: string;
  /** Optional sink for handler errors. */
  onError?: (err: unknown) => void;
}

/** A live HTTP face attached to an http.Server. */
export interface HttpServeHandle {
  /** Detach the request listener. */
  close(): void;
}

/**
 * Attach a JSON-over-HTTP face to `httpServer`. Returns a handle whose close()
 * detaches the listener. Non-matching requests are passed through untouched so
 * httpServe can coexist with the app's own request handler and with serve()'s
 * WebSocket upgrade on the same server.
 */
export function httpServe<Ctx>(
  httpServer: HttpServer,
  opts: HttpServeOptions<Ctx>,
): HttpServeHandle {
  const onError = opts.onError ?? (() => {});
  const prefix = normalizePrefix(opts.prefix ?? "");

  // path → route, built once. Promise ordinal collisions are the caller's
  // concern (each method has a distinct path by construction).
  const table = new Map<string, HttpRoute>();
  for (const r of opts.routes) table.set(prefix + r.path, r);

  // Take over `request` dispatch: capture the app's existing listeners, detach
  // them, and install a single dispatcher that either handles a matched route
  // fully (so the response is written exactly once) or delegates to the
  // captured listeners. Because route handling is async (mintCap, body read),
  // a plain extra listener would race the app's synchronous catch-all; owning
  // dispatch is the only way to guarantee a single writer per request.
  type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
  const appListeners = httpServer.listeners("request") as RequestListener[];
  httpServer.removeAllListeners("request");

  const delegate = (req: IncomingMessage, res: ServerResponse): void => {
    if (appListeners.length === 0) {
      if (!res.writableEnded) {
        writeJson(res, 404, { error: "not found" });
      }
      return;
    }
    for (const l of appListeners) l(req, res);
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      delegate(req, res);
      return;
    }
    const route = table.get(url.pathname);
    if (!route) {
      delegate(req, res); // not ours — hand to the app's own handler.
      return;
    }

    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed; use POST" });
      return;
    }

    void handle(req, res, route, opts, onError).catch((err) => {
      onError(err);
      if (!res.headersSent) writeJson(res, 500, { error: "internal error" });
    });
  };

  httpServer.on("request", onRequest);
  return {
    close(): void {
      httpServer.removeListener("request", onRequest);
      // Restore the app's original listeners.
      for (const l of appListeners) httpServer.on("request", l);
    },
  };
}

/** handle runs one matched POST through mint → decode → dispatch → encode. */
async function handle<Ctx>(
  req: IncomingMessage,
  res: ServerResponse,
  route: HttpRoute,
  opts: HttpServeOptions<Ctx>,
  onError: (err: unknown) => void,
): Promise<void> {
  // Auth boundary — identical slot to serve()'s upgrade mint.
  let ctx: Ctx | null;
  try {
    ctx = await opts.mintCap(req);
  } catch (err) {
    onError(err);
    writeJson(res, 500, { error: "auth error" });
    return;
  }
  if (ctx === null) {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  // Read + parse the JSON request body.
  let json: unknown;
  try {
    const raw = await readBody(req);
    json = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    writeJson(res, 400, { error: "invalid JSON request body" });
    return;
  }

  // JSON → ZAP payload bytes (schema-specific codec from the route).
  let payload: Uint8Array;
  try {
    payload = route.decode(json);
  } catch (err) {
    writeJson(res, 400, {
      error: err instanceof Error ? err.message : "request decode failed",
    });
    return;
  }

  // Build the Call and dispatch it through the SAME handler the WS path uses.
  let handler: CallHandler;
  try {
    handler = opts.rootCap(ctx);
  } catch (err) {
    onError(err);
    writeJson(res, 500, { error: "rootCap failed" });
    return;
  }

  const call: Call = {
    method: route.method,
    promiseID: 1,
    target: NO_TARGET,
    cap: EMPTY,
    payload,
  };

  let resp: Response;
  try {
    resp = await handler(call);
  } catch (err) {
    onError(err);
    writeJson(res, 500, { error: "handler error" });
    return;
  }

  if (resp.status !== Status.OK) {
    writeJson(res, httpStatusFor(resp.status), {
      error: errorBodyText(resp.body) ?? `status ${resp.status}`,
    });
    return;
  }

  // Void method: 204, no body.
  if (!route.encode) {
    res.writeHead(204);
    res.end();
    return;
  }

  // ZAP response body → JSON value.
  let out: unknown;
  try {
    out = route.encode(resp.body);
  } catch (err) {
    onError(err);
    writeJson(res, 500, { error: "response encode failed" });
    return;
  }
  writeJson(res, 200, out);
}

/** readBody collects the request body as a UTF-8 string, capped at the ceiling. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** writeJson sends a JSON response with the given HTTP status. */
function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
  });
  res.end(body);
}

/** Map a ZAP Status to the closest HTTP status (they share the 4xx/5xx space). */
function httpStatusFor(zapStatus: number): number {
  switch (zapStatus) {
    case Status.BadRequest:
    case Status.Unauthorized:
    case Status.Forbidden:
    case Status.NotFound:
    case Status.Internal:
      return zapStatus;
    default:
      return zapStatus >= 400 && zapStatus <= 599 ? zapStatus : 500;
  }
}

/** errorBodyText extracts {"error": "..."} text from a ZAP error body, if any. */
function errorBodyText(body: Uint8Array): string | null {
  if (body.byteLength === 0) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON — fall through.
  }
  return null;
}

/** normalizePrefix trims a trailing slash and ensures a leading slash (or ""). */
function normalizePrefix(prefix: string): string {
  if (prefix === "" || prefix === "/") return "";
  let p = prefix.startsWith("/") ? prefix : "/" + prefix;
  if (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}
