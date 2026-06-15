// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

import type { IncomingMessage } from "node:http";

/**
 * MintCap is the boundary where a bearer (cookie, header, session) becomes a
 * typed Capability that downstream RPC methods are authorized against.
 *
 * v0 ships the SLOT — apps supply their own fn. The canonical ML-DSA-65 signed
 * Capability mint (per zap-spec/capabilities.zap — the 3408-byte signature
 * footer, BLAKE3 object identity, attenuable/revocable authority) lands in a
 * later version. Until then you can return any object: whatever non-null value
 * you return becomes the `ctx` threaded into your `rootCap(ctx)` factory and
 * carried on every {@link import("@hanzo/zap").Call} as its capability buffer.
 *
 * Return `null` to reject the connection with HTTP 401 before the WebSocket
 * upgrade completes — no socket is opened for an unauthorized request.
 *
 * @typeParam Ctx - the minted authority/context type your handlers consume.
 * @param req - the raw HTTP upgrade request (read `req.headers.authorization`,
 *              cookies, etc.).
 * @returns the minted context, or `null` to reject with 401.
 */
export type MintCap<Ctx> = (req: IncomingMessage) => Promise<Ctx | null>;
