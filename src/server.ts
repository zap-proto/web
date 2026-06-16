// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

/**
 * server.ts — serve(httpServer, opts): attach a ZAP-over-WebSocket RPC endpoint
 * to an existing Node http.Server.
 *
 * Sharing one http.Server is the integration seam: Next.js's
 * `app.getRequestHandler()` and a Remix Node server both run on a plain
 * http.Server, so a single `serve(server, ...)` line adds ZAP RPC alongside the
 * app without a second port. (Same shape as the WebSocket attachments in
 * hanzo/platform's app/platform/server/server.ts.)
 *
 * Auth runs at the upgrade boundary: mintCap(req) is awaited BEFORE the
 * handshake completes. A null mint writes HTTP 401 and destroys the socket — no
 * WebSocket is ever opened for an unauthorized request. A non-null mint becomes
 * the per-connection `ctx`, and rootCap(ctx) yields the CallHandler that
 * dispatches every decoded ZAP Call on that connection.
 *
 * `ws` is a peer dependency (server side only); we import it lazily so the
 * browser bundle never pulls it in.
 */

import { createRequire } from "node:module";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import type { CallHandler } from "./conn.js";
import { Conn } from "./conn.js";
import { nodeWsTransport } from "./transport.js";
import type { MintCap } from "./auth.js";

// `@zap-proto/web/server` is the complete Node surface. Re-export the
// server-side transport factory and the auth slot so consumers import the whole
// server API from one sub-path (the root entry is browser-safe and omits these).
export { nodeWsTransport } from "./transport.js";
export type { MintCap } from "./auth.js";

// httpServe mounts a JSON-over-HTTP face on the SAME ZAP service, dispatching
// each POST /<service>/<method> through the identical CallHandler serve() uses
// over WebSocket. The OpenAPI doc emitted by `zapgen --emit=openapi` describes
// exactly these routes.
export { httpServe } from "./http.js";
export type {
  HttpRoute,
  HttpServeOptions,
  HttpServeHandle,
} from "./http.js";

/**
 * rootCap produces the per-connection dispatch root for a minted ctx.
 *
 * On the real @zap-proto/zap foundation a "service" is a dispatcher over decoded
 * Calls (method ordinal + payload), not a Cap'n Proto Server object — so the
 * bootstrap capability is modelled here as a {@link CallHandler}. Generated
 * zapgen bindings give you the typed param/result views to decode the payload
 * and encode the response body inside that handler.
 */
export type RootCap<Ctx> = (ctx: Ctx) => CallHandler;

/** Options for {@link serve}. */
export interface ServeOptions<Ctx> {
  /** Upgrade path this endpoint binds to (default "/zap"). */
  path?: string;
  /** Bearer→ctx boundary; return null to reject the upgrade with HTTP 401. */
  mintCap: MintCap<Ctx>;
  /** Produce the bootstrap dispatch handler for the minted ctx. */
  rootCap: RootCap<Ctx>;
  /** Optional sink for connection/dispatch errors. */
  onError?: (err: unknown) => void;
}

/** A live ZAP-over-WebSocket endpoint attached to an http.Server. */
export interface ServeHandle {
  /** Close the endpoint and every live connection. */
  close(): Promise<void>;
}

/**
 * Attach a ZAP RPC endpoint to `httpServer`. Returns a handle whose close()
 * tears down the WebSocket server and all open connections.
 */
export function serve<Ctx>(
  httpServer: HttpServer,
  opts: ServeOptions<Ctx>,
): ServeHandle {
  const path = opts.path ?? "/zap";
  const onError = opts.onError ?? (() => {});

  // Lazy require so browser bundles never resolve `ws`. createRequire keeps
  // this ESM-safe (no top-level `require`) and server-only (node:module never
  // ends up in a browser bundle, since serve() is the Node entry).
  const req = createRequire(import.meta.url);
  const { WebSocketServer } = req("ws") as typeof import("ws");
  const wss = new WebSocketServer({ noServer: true });
  const conns = new Set<Conn>();

  const onUpgrade = (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return; // not ours; let other upgrade listeners handle it.
    }
    if (url.pathname !== path) return; // path mismatch — not our endpoint.

    void (async () => {
      let ctx: Ctx | null;
      try {
        ctx = await opts.mintCap(req);
      } catch (err) {
        onError(err);
        reject(socket, 500, "Internal Server Error");
        return;
      }
      if (ctx === null) {
        reject(socket, 401, "Unauthorized");
        return;
      }
      const minted = ctx;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const transport = nodeWsTransport(ws);
        let handler: CallHandler;
        try {
          handler = opts.rootCap(minted);
        } catch (err) {
          onError(err);
          transport.close(1011, "rootCap failed");
          return;
        }
        const conn = new Conn(transport, { handler });
        conns.add(conn);
        transport.onClose(() => conns.delete(conn));
        ws.on("error", onError);
      });
    })();
  };

  httpServer.on("upgrade", onUpgrade);

  return {
    async close(): Promise<void> {
      httpServer.removeListener("upgrade", onUpgrade);
      for (const conn of conns) conn.close(1001, "server shutting down");
      conns.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** Write a bare HTTP error response on the raw upgrade socket and destroy it. */
function reject(socket: Socket, code: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${code} ${text}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
  socket.destroy();
}
