// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

/**
 * client.ts — connect(url, opts): open a ZAP-over-WebSocket RPC connection from
 * the browser (or Node, for tests) and return the bootstrap call surface.
 *
 * The transport is isomorphic: in the browser this uses the native WebSocket
 * global; in Node you inject the `ws` package's WebSocket via
 * {@link ConnectOptions.WebSocketImpl} (Node 22+ also has a built-in global
 * WebSocket, but it cannot set request headers — see the bearer note below).
 *
 * Bearer note: the browser's native WebSocket constructor CANNOT set an
 * Authorization header — the WS protocol gives JS no header control. So:
 *   - Node `ws` (tests, SSR): we pass `{ headers: { Authorization } }`, which
 *     `ws` forwards on the upgrade request, where serve()'s mintCap reads it.
 *   - browser: rely on a cookie sent automatically on the upgrade, or encode
 *     the bearer in a subprotocol; the Authorization-header path only applies
 *     to a header-capable WebSocketImpl. We feature-detect by arity and fall
 *     back to a query param (`?authorization=Bearer%20...`) the server can read.
 */

import { Conn } from "./conn.js";
import { browserWsTransport } from "./transport.js";
import { WebRpcError } from "./errors.js";

/** Options for {@link connect}. */
export interface ConnectOptions {
  /** Bearer token; forwarded as `Authorization: Bearer <bearer>` on upgrade. */
  bearer?: string;
  /**
   * WebSocket constructor to use. Defaults to globalThis.WebSocket (browser /
   * Node 22+). Inject the `ws` package's WebSocket in Node tests/SSR so the
   * bearer can ride an Authorization header.
   */
  WebSocketImpl?: typeof WebSocket;
}

/**
 * The bootstrap call surface returned by {@link connect}. RootCap is the
 * generated typed wrapper a consumer layers over the raw {@link Conn} call
 * surface — `connect<MyRootCap>(...)` then exposes typed methods on `bootstrap`.
 *
 * On the real @zap-proto/zap foundation the bootstrap is the connection's call
 * surface (method ordinal + ZAP payload), not a Cap'n Proto capability object.
 * The default `RootCap = Conn` gives you raw `bootstrap.call(method, { payload })`;
 * a zapgen-generated client wraps that into named, typed methods.
 */
export interface Connection<RootCap = Conn> {
  bootstrap: RootCap;
  close(): void;
}

/**
 * Open a ZAP RPC WebSocket to `url`, wait for the connection to open, and
 * return the bootstrap call surface. The default RootCap is the raw {@link Conn}.
 */
export async function connect<RootCap = Conn>(
  url: string,
  opts: ConnectOptions = {},
): Promise<Connection<RootCap>> {
  const Impl = opts.WebSocketImpl ?? (globalThis.WebSocket as typeof WebSocket);
  if (!Impl) {
    throw new WebRpcError(
      "zap-web: no WebSocket implementation (pass opts.WebSocketImpl)",
    );
  }

  const ws = openSocket(Impl, url, opts.bearer);

  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onErr = (): void => {
      cleanup();
      reject(new WebRpcError(`zap-web: failed to connect to ${url}`));
    };
    const onClose = (ev: unknown): void => {
      cleanup();
      const code = (ev as CloseEvent | undefined)?.code;
      reject(
        new WebRpcError(
          `zap-web: upgrade rejected by ${url}`,
          code === 1006 ? 401 : code,
        ),
      );
    };
    const cleanup = (): void => {
      remove(ws, "open", onOpen);
      remove(ws, "error", onErr);
      remove(ws, "close", onClose);
    };
    add(ws, "open", onOpen);
    add(ws, "error", onErr);
    add(ws, "close", onClose);
  });

  const transport = browserWsTransport(ws);
  const conn = new Conn(transport);

  return {
    bootstrap: conn as unknown as RootCap,
    close(): void {
      conn.close(1000, "client closed");
    },
  };
}

/**
 * Construct a WebSocket, attaching the bearer the best way the impl allows.
 * Node `ws` accepts a 3rd `options.headers` arg; the browser native WebSocket
 * does not, so we fall back to a query param the server can read.
 */
function openSocket(
  Impl: typeof WebSocket,
  url: string,
  bearer?: string,
): WebSocket {
  if (!bearer) return new Impl(url);

  // Node `ws` WebSocket: third constructor arg is options { headers }.
  // We detect header support by the constructor's declared arity (>= 3).
  if ((Impl as unknown as { length: number }).length >= 3) {
    return new (Impl as unknown as new (
      u: string,
      protocols: undefined,
      options: { headers: Record<string, string> },
    ) => WebSocket)(url, undefined, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
  }

  // Browser native WebSocket: no header control — encode on the URL instead.
  const u = new URL(url);
  u.searchParams.set("authorization", `Bearer ${bearer}`);
  return new Impl(u.toString());
}

// --- isomorphic add/remove listener (browser EventTarget vs `ws` emitter) ---

function add(ws: WebSocket, type: string, fn: (ev?: unknown) => void): void {
  const anyWs = ws as unknown as {
    addEventListener?: (t: string, f: (ev: unknown) => void) => void;
    on?: (t: string, f: (...a: unknown[]) => void) => void;
  };
  if (typeof anyWs.addEventListener === "function") {
    anyWs.addEventListener(type, fn);
  } else if (typeof anyWs.on === "function") {
    anyWs.on(type, fn);
  }
}

function remove(ws: WebSocket, type: string, fn: (ev?: unknown) => void): void {
  const anyWs = ws as unknown as {
    removeEventListener?: (t: string, f: (ev: unknown) => void) => void;
    off?: (t: string, f: (...a: unknown[]) => void) => void;
  };
  if (typeof anyWs.removeEventListener === "function") {
    anyWs.removeEventListener(type, fn);
  } else if (typeof anyWs.off === "function") {
    anyWs.off(type, fn);
  }
}
