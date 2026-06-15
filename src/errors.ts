// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

/**
 * errors.ts — error surface for the web RPC layer.
 *
 * Method/wire-level decode failures keep using @zap-proto/zap's ZapParseError (the
 * runtime throws it on a bad magic/version/size); we re-export it so consumers
 * have one import site. WebRpcError is new: it covers transport-level failures
 * that only exist at the WebSocket boundary — a rejected upgrade, a socket that
 * closes mid-call, or a non-OK RPC status surfaced to the caller.
 */

export { ZapParseError } from "@zap-proto/zap";

/**
 * WebRpcError is raised for WebSocket-transport-level failures: the upgrade was
 * rejected (401/other), the socket closed while a call was in flight, or a
 * call returned a non-OK ZAP status. `status` carries the ZAP/HTTP status when
 * one is known (e.g. 401 for a rejected mint, or the response envelope status).
 */
export class WebRpcError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "WebRpcError";
    this.status = status;
  }
}
