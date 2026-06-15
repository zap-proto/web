// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

/**
 * transport.ts — an isomorphic WebSocket transport for ZAP RPC frames.
 *
 * The foundation runtime (@hanzo/zap) frames a call as a single ZAP envelope
 * (envelope.ts buildRequest / buildResponse). Over TCP, @hanzo/zap's ZapClient
 * length-prefixes each envelope to recover message boundaries. WebSocket binary
 * frames already give us message boundaries for free, so the framing here is
 * one ZAP envelope = one WS binary message — no extra length prefix.
 *
 * A single internal impl (makeWsTransport) feature-detects whether it is given
 * the `ws` package WebSocket (Node, post-upgrade) or the browser's native
 * WebSocket, and normalises both to the same {@link WsTransport} shape. Bytes
 * in arrive as ArrayBuffer or Uint8Array (or, on Node `ws`, a Buffer) and are
 * normalised to Uint8Array; bytes out are written as Uint8Array.
 *
 * Cap'n Proto-style text frames are a protocol violation: ZAP is binary-only.
 * A received text frame closes the connection with WebSocket close code 1003
 * (Unsupported Data).
 */

/** WebSocket close code for a non-binary (text) frame — Unsupported Data. */
export const WS_CLOSE_UNSUPPORTED = 1003;

/**
 * WsTransport is the byte pipe a ZAP RPC connection rides on. It is duplex and
 * message-oriented: every {@link send} ships exactly one ZAP envelope, and the
 * {@link onMessage} callback fires once per inbound envelope.
 */
export interface WsTransport {
  /** Ship one ZAP envelope as a single binary WebSocket message. */
  send(bytes: Uint8Array): void;
  /** Register the inbound-envelope handler. At most one is active. */
  onMessage(handler: (bytes: Uint8Array) => void): void;
  /** Register the close handler (fires once, on either side closing). */
  onClose(handler: (code: number, reason: string) => void): void;
  /** Close the underlying socket. */
  close(code?: number, reason?: string): void;
}

/** The subset of the WebSocket API this transport relies on, in either env. */
interface SocketLike {
  binaryType?: string;
  send(data: Uint8Array | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (ev: unknown) => void): void;
  on?(type: string, listener: (...args: unknown[]) => void): void;
}

/** Normalise any WS payload shape to a Uint8Array, or null for a text frame. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  // Node `ws` can hand back an array of Buffers when fragmented; coalesce.
  if (Array.isArray(data)) {
    const parts = data.map(toBytes);
    if (parts.some((p) => p === null)) return null;
    const total = parts.reduce((n, p) => n + (p as Uint8Array).byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p as Uint8Array, off);
      off += (p as Uint8Array).byteLength;
    }
    return out;
  }
  // A string payload is a text frame — a protocol violation for ZAP.
  return null;
}

/**
 * Wrap a socket (browser native WebSocket or Node `ws` WebSocket) as a
 * {@link WsTransport}. Branches on whether the socket exposes the browser
 * `addEventListener` API or the Node `ws` `on(...)` emitter API.
 */
function makeWsTransport(socket: SocketLike): WsTransport {
  // Ask for ArrayBuffer payloads where the API allows it (browser + `ws`),
  // so toBytes has a fast path and never sees a Blob.
  if ("binaryType" in socket) socket.binaryType = "arraybuffer";

  let onMsg: (bytes: Uint8Array) => void = () => {};
  let onClose: (code: number, reason: string) => void = () => {};
  let closed = false;

  const handleData = (data: unknown): void => {
    const bytes = toBytes(data);
    if (bytes === null) {
      // Text frame (or unrecognised payload): reject per ZAP binary-only rule.
      if (!closed) {
        closed = true;
        socket.close(WS_CLOSE_UNSUPPORTED, "zap: binary frames only");
      }
      return;
    }
    onMsg(bytes);
  };

  const handleClose = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    onClose(code, reason);
  };

  if (typeof socket.addEventListener === "function") {
    // Browser native WebSocket.
    socket.addEventListener("message", (ev: unknown) =>
      handleData((ev as MessageEvent).data),
    );
    socket.addEventListener("close", (ev: unknown) => {
      const ce = ev as CloseEvent;
      handleClose(ce.code ?? 1006, ce.reason ?? "");
    });
    socket.addEventListener("error", () => handleClose(1006, "error"));
  } else if (typeof socket.on === "function") {
    // Node `ws` WebSocket.
    socket.on("message", (data: unknown, isBinary?: unknown) => {
      // `ws` passes (data, isBinary); a false isBinary is a text frame.
      if (isBinary === false) {
        handleData("text");
        return;
      }
      handleData(data);
    });
    socket.on("close", (code: unknown, reason: unknown) =>
      handleClose(
        typeof code === "number" ? code : 1006,
        reason ? String(reason) : "",
      ),
    );
    socket.on("error", () => handleClose(1006, "error"));
  } else {
    throw new TypeError("zap-web: unsupported WebSocket implementation");
  }

  return {
    send(bytes: Uint8Array): void {
      if (closed) throw new Error("zap-web: transport closed");
      socket.send(bytes);
    },
    onMessage(handler: (bytes: Uint8Array) => void): void {
      onMsg = handler;
    },
    onClose(handler: (code: number, reason: string) => void): void {
      onClose = handler;
    },
    close(code?: number, reason?: string): void {
      if (closed) return;
      closed = true;
      socket.close(code, reason);
    },
  };
}

/**
 * Wrap a Node `ws` package WebSocket (after the HTTP upgrade completes) as a
 * {@link WsTransport}. Server side.
 */
export function nodeWsTransport(ws: unknown): WsTransport {
  return makeWsTransport(ws as SocketLike);
}

/**
 * Wrap the browser's native WebSocket as a {@link WsTransport}. Client side.
 */
export function browserWsTransport(ws: unknown): WsTransport {
  return makeWsTransport(ws as SocketLike);
}
