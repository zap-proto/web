// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Status, type Call, type Response } from "@hanzo/zap";
import { connect, serve, WebRpcError, type Conn } from "../src/index.js";
import {
  EchoArgs,
  EchoResult,
  newEchoArgs,
  newEchoResult,
} from "./gen/echo_zap.js";

// EchoCap interface, one method: echo(text) -> (text). The .zap interface
// method ordinal — here method 0 is `echo`.
const ECHO = 0;

// A server-side EchoCap impl: decode EchoArgs from the call payload, echo the
// text straight back as an EchoResult body. This is exactly what a zapgen
// server skeleton would dispatch into.
function echoHandler(call: Call): Response {
  if (call.method !== ECHO) {
    return {
      status: Status.NotFound,
      promiseID: call.promiseID,
      body: new Uint8Array(0),
    };
  }
  const args = EchoArgs.wrap(call.payload);
  const body = newEchoResult({ msg: args.msg });
  return { status: Status.OK, promiseID: call.promiseID, body };
}

let server: Server;
let url: string;

function listen(s: Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        resolve(`ws://127.0.0.1:${addr.port}/zap`);
      } else {
        throw new Error("no address");
      }
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("@hanzo/zap-web echo roundtrip", () => {
  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    serve(server, {
      // mintCap slot: accept anyone carrying a bearer; reject the rest.
      mintCap: async (req) => {
        const auth = req.headers.authorization;
        return auth ? { bearer: auth } : null;
      },
      // rootCap(ctx) yields the dispatch handler for this connection.
      rootCap: () => echoHandler,
    });
    url = await listen(server);
  });

  it("roundtrips a ZAP message over a real WebSocket", async () => {
    const { bootstrap, close } = await connect<Conn>(url, {
      bearer: "test-token",
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });

    const resp = await bootstrap.call(ECHO, {
      payload: argsFor("hello"),
    });

    expect(resp.status).toBe(Status.OK);
    expect(EchoResult.wrap(resp.body).msg).toBe("hello");
    close();
  });

  it("rejects the upgrade with 401 when mintCap returns null", async () => {
    await expect(
      connect<Conn>(url, {
        // no bearer → mintCap returns null → HTTP 401, upgrade rejected.
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      }),
    ).rejects.toBeInstanceOf(WebRpcError);
  });

  it("shares one conn across two sequential calls", async () => {
    const { bootstrap, close } = await connect<Conn>(url, {
      bearer: "test-token",
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });

    const first = await bootstrap.call(ECHO, { payload: argsFor("one") });
    const second = await bootstrap.call(ECHO, { payload: argsFor("two") });

    expect(EchoResult.wrap(first.body).msg).toBe("one");
    expect(EchoResult.wrap(second.body).msg).toBe("two");
    close();
  });
});

// Build an EchoArgs payload via the generated builder.
function argsFor(text: string): Uint8Array {
  return newEchoArgs({ msg: text });
}
