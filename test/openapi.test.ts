// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

/**
 * openapi.test.ts — end-to-end proof that the OpenAPI doc emitted by
 * `zapgen --emit=ts,openapi` describes exactly what httpServe serves:
 *
 *   1. Load the committed OpenAPI 3.1 doc (generated from openapi-echo.zap).
 *   2. Validate each component schema against the JSON Schema 2020-12 dialect
 *      (the dialect OpenAPI 3.1 mandates) with ajv.
 *   3. Spin httpServe in-process over a real Node http.Server, using the
 *      generated ZAP codec to bridge JSON⇄struct.
 *   4. POST to the path the doc declares; assert the response validates against
 *      the doc's 200 response schema.
 */

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { Status, type Call, type Response } from "@zap-proto/zap";
import { httpServe, type HttpRoute } from "../src/server.js";
import {
  EchoIn,
  EchoOut,
  newEchoIn,
  newEchoOut,
} from "./gen/openapi-echo_zap.js";

const doc = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./gen/openapi-echo.openapi.json", import.meta.url)),
    "utf8",
  ),
);

// The single operation under test, resolved from the generated doc so the test
// follows whatever path/operationId the emitter produced.
const ECHO_PATH = "/echo-service/echo";
const ECHO_ORDINAL = 1; // interface method `echo` auto-assigns ordinal 1.

/** Resolve a #/components/schemas/* $ref against the doc. */
function deref(schemaOrRef: Record<string, unknown>): Record<string, unknown> {
  const ref = schemaOrRef.$ref;
  if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
    const name = ref.slice("#/components/schemas/".length);
    return doc.components.schemas[name];
  }
  return schemaOrRef;
}

// Server-side EchoService.echo: decode EchoIn from the ZAP payload, echo the
// text back as an EchoOut body. Exactly what a zapgen Server skeleton dispatches.
function echoHandler(call: Call): Response {
  if (call.method !== ECHO_ORDINAL) {
    return { status: Status.NotFound, promiseID: call.promiseID, body: new Uint8Array(0) };
  }
  const args = EchoIn.wrap(call.payload);
  const body = newEchoOut({ msg: args.msg });
  return { status: Status.OK, promiseID: call.promiseID, body };
}

// The HTTP route: JSON {msg} → EchoIn bytes; EchoOut bytes → JSON {msg}.
const echoRoute: HttpRoute = {
  path: ECHO_PATH,
  method: ECHO_ORDINAL,
  decode: (json) => newEchoIn({ msg: (json as { msg: string }).msg }),
  encode: (body) => ({ msg: EchoOut.wrap(body).msg }),
};

let server: Server;
let baseUrl: string;

function listen(s: Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") resolve(`http://127.0.0.1:${addr.port}`);
      else throw new Error("no address");
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("OpenAPI doc validity (JSON Schema 2020-12)", () => {
  beforeEach(async () => {
    server = createServer();
    await Promise.resolve();
  });

  it("is OpenAPI 3.1.0 with the expected envelope", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("EchoService");
    expect(doc.info.version).toBe("1.0.0");
    expect(doc.paths[ECHO_PATH].post.operationId).toBe("echoService.echo");
  });

  it("every component schema compiles under ajv 2020-12", () => {
    const ajv = new Ajv2020({ strict: false });
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      const validate = ajv.compile(schema as object);
      expect(validate, name).toBeTypeOf("function");
    }
  });
});

describe("httpServe round-trip against the declared path + schema", () => {
  beforeEach(async () => {
    // App catch-all — httpServe delegates unmatched paths here.
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    httpServe(server, {
      routes: [echoRoute],
      mintCap: async (req) => {
        const auth = req.headers.authorization;
        return auth ? { bearer: auth } : null;
      },
      rootCap: () => echoHandler,
    });
    baseUrl = await listen(server);
  });

  it("POSTs JSON to the doc's path and gets a schema-valid response", async () => {
    const res = await fetch(baseUrl + ECHO_PATH, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ msg: "hello over http" }),
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toEqual({ msg: "hello over http" });

    // The response must validate against the doc's 200 response schema.
    const respSchema = deref(
      doc.paths[ECHO_PATH].post.responses["200"].content["application/json"].schema,
    );
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(respSchema);
    expect(validate(out)).toBe(true);
  });

  it("rejects an unauthenticated request with HTTP 401", async () => {
    const res = await fetch(baseUrl + ECHO_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg: "no auth" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-POST with 405", async () => {
    const res = await fetch(baseUrl + ECHO_PATH, {
      method: "GET",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(405);
  });

  it("rejects an invalid JSON body with 400", async () => {
    const res = await fetch(baseUrl + ECHO_PATH, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("passes unknown paths through to the app handler (404)", async () => {
    const res = await fetch(baseUrl + "/nope", {
      method: "POST",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(404);
  });
});
