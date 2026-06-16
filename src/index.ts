// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

/**
 * @zap-proto/web — browser-frontend RPC over ZAP.
 *
 * A drop-in tRPC replacement that speaks native ZAP envelopes over WebSocket
 * binary frames instead of JSON-over-HTTP. Layered on @zap-proto/zap (the wire
 * runtime). Service shape comes from .zap schemas via `zapgen --target=ts`, not
 * a Zod/procedure DSL. Binary only — no JSON fallback, no Cap'n Proto.
 *
 * This root entry is BROWSER-SAFE — it imports no Node built-ins. The Node
 * server (`serve`, `nodeWsTransport`, the `MintCap` auth slot) lives behind the
 * `@zap-proto/web/server` sub-path so `node:module` / `createRequire` never
 * leaks into a browser bundle.
 *
 *   - connect(url, opts)   — open a typed RPC connection (browser or Node).
 *   - browserWsTransport   — wrap the browser's native WebSocket.
 *   - Conn                 — the duplex ZAP RPC connection.
 *
 * For the Node server side, import from `@zap-proto/web/server`:
 *
 *   import { serve } from "@zap-proto/web/server";
 */

export { connect } from "./client.js";
export type { ConnectOptions, Connection } from "./client.js";

export { browserWsTransport, WS_CLOSE_UNSUPPORTED } from "./transport.js";
export type { WsTransport } from "./transport.js";

export { Conn } from "./conn.js";
export type { CallHandler, CallOptions } from "./conn.js";

export { WebRpcError, ZapParseError } from "./errors.js";
