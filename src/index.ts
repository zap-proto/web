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
 *   - serve(httpServer, opts)   — Node: attach a ZAP RPC endpoint to http.Server.
 *   - connect(url, opts)        — browser/Node: open a typed RPC connection.
 *   - {node,browser}WsTransport — isomorphic WS transport factories.
 *   - MintCap                   — the bearer→ctx auth slot at the upgrade.
 */

export { serve } from "./server.js";
export type { ServeOptions, ServeHandle, RootCap } from "./server.js";

export { connect } from "./client.js";
export type { ConnectOptions, Connection } from "./client.js";

export {
  nodeWsTransport,
  browserWsTransport,
  WS_CLOSE_UNSUPPORTED,
} from "./transport.js";
export type { WsTransport } from "./transport.js";

export { Conn } from "./conn.js";
export type { CallHandler, CallOptions } from "./conn.js";

export type { MintCap } from "./auth.js";

export { WebRpcError, ZapParseError } from "./errors.js";
