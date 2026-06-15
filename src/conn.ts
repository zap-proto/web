// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

/**
 * conn.ts — a transport-agnostic ZAP RPC connection over a {@link WsTransport}.
 *
 * This is the shared core of both serve() and connect(). It mirrors the
 * correlation logic of @zap-proto/zap's ZapClient (Node TCP), but rides a duplex
 * WebSocket transport instead of a TCP socket and works in both directions:
 *
 *   - client side: call() ships a request envelope and resolves its Response
 *     when the matching promiseID comes back.
 *   - server side: an inbound request envelope is decoded into a Call and
 *     handed to the registered handler, whose Response is shipped back.
 *
 * Each WS binary message is exactly one ZAP envelope (see transport.ts), so the
 * envelope's own header tag (MSG_TYPE_ROUTER_BASE) distinguishes a request from
 * a response and there is no extra framing. We disambiguate direction by trying
 * the request decode first; a frame that parses as a request with a known
 * method is dispatched as a server call, otherwise it is treated as a response
 * to one of our outstanding promises.
 */

import {
  buildRequest,
  buildResponse,
  parseRequest,
  parseResponse,
  NO_TARGET,
  Status,
  type Call,
  type Response,
} from "@zap-proto/zap";
import type { WsTransport } from "./transport.js";
import { WebRpcError } from "./errors.js";

/** A server-side request handler: a decoded Call in, a Response out. */
export type CallHandler = (call: Call) => Promise<Response> | Response;

/** Options for an outbound {@link Conn.call}. */
export interface CallOptions {
  /** Pipeline this call off an earlier call's promiseID (0 = root). */
  target?: number;
  /** Capability buffer to carry on the call (defaults to the conn's cap). */
  cap?: Uint8Array;
  /** Method params, ZAP-encoded. */
  payload?: Uint8Array;
}

const EMPTY = new Uint8Array(0);

/**
 * Conn correlates ZAP request/response envelopes over a single duplex
 * WebSocket transport. One Conn is FIFO per direction on the wire, matching the
 * Go node's per-connection dispatch.
 */
export class Conn {
  private readonly pending = new Map<number, (r: Response) => void>();
  private promiseSeq = 0;
  private closed = false;
  private handler: CallHandler | null = null;
  private readonly cap: Uint8Array;

  constructor(
    private readonly transport: WsTransport,
    opts: { handler?: CallHandler; cap?: Uint8Array } = {},
  ) {
    this.handler = opts.handler ?? null;
    this.cap = opts.cap ?? EMPTY;
    transport.onMessage((bytes) => this.onFrame(bytes));
    transport.onClose(() => this.fail());
  }

  /**
   * Ship one Call and await its correlated Response. The promiseID is assigned
   * here unless the caller pipelines via {@link CallOptions.target}.
   */
  call(method: number, opts: CallOptions = {}): Promise<Response> {
    if (this.closed) {
      return Promise.reject(new WebRpcError("zap-web: connection closed"));
    }
    this.promiseSeq = (this.promiseSeq + 1) >>> 0 || 1;
    const promiseID = this.promiseSeq;
    const c: Call = {
      method,
      promiseID,
      target: opts.target ?? NO_TARGET,
      cap: opts.cap ?? this.cap,
      payload: opts.payload ?? EMPTY,
    };
    return new Promise<Response>((resolve, reject) => {
      this.pending.set(promiseID, resolve);
      try {
        this.transport.send(buildRequest(c));
      } catch (err) {
        this.pending.delete(promiseID);
        reject(err instanceof Error ? err : new WebRpcError(String(err)));
      }
    });
  }

  /** Close the connection and fail all in-flight calls. */
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.transport.close(code, reason);
    this.fail();
  }

  private onFrame(bytes: Uint8Array): void {
    if (this.handler) {
      // Server side: every inbound frame is a request to dispatch.
      this.dispatch(bytes);
      return;
    }
    // Client side: every inbound frame is a response to one of our calls.
    let resp: Response;
    try {
      resp = parseResponse(bytes);
    } catch {
      return; // malformed frame from peer — drop it.
    }
    const resolve = this.pending.get(resp.promiseID);
    if (!resolve) return;
    this.pending.delete(resp.promiseID);
    resolve(resp);
  }

  private async dispatch(bytes: Uint8Array): Promise<void> {
    let call: Call;
    try {
      call = parseRequest(bytes);
    } catch {
      return; // unparseable request — drop it.
    }
    const handler = this.handler;
    if (!handler) return;
    let resp: Response;
    try {
      resp = await handler(call);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "internal handler error";
      resp = {
        status: Status.Internal,
        promiseID: call.promiseID,
        body: new TextEncoder().encode(JSON.stringify({ error: msg })),
      };
    }
    if (this.closed) return;
    try {
      this.transport.send(
        buildResponse(resp.status, call.promiseID, resp.body),
      );
    } catch {
      // peer went away mid-response — nothing to do.
    }
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, resolve] of this.pending) {
      resolve({
        status: 0,
        promiseID: 0,
        body: new TextEncoder().encode(
          JSON.stringify({ error: "connection closed" }),
        ),
      });
    }
    this.pending.clear();
  }
}
