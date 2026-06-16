# @zap-proto/web

Browser-frontend RPC over **ZAP** — a drop-in tRPC replacement for Next.js /
Remix / SvelteKit. Native ZAP envelopes over WebSocket binary frames, layered
cleanly on [`@zap-proto/zap`](https://github.com/zap-proto/ts) (the ZAP wire
runtime). `v0.1.0` — pre-1.0 by policy; no version tags until the full chain
works end-to-end.

> **Note on naming.** The foundation runtime is `@zap-proto/zap` (the canonical
> TypeScript ZAP runtime, repo `zap-proto/ts`). This package — the WebSocket
> frontend layer — is `@zap-proto/web`, repo `zap-proto/web`. It is **not**
> Cap'n Proto; ZAP is a zero-copy, zero-dependency binary format byte-compatible
> with the Go runtime `github.com/zap-proto/go` and `github.com/luxfi/zap`.

## What @zap-proto/web IS

- A **drop-in replacement for tRPC** across Hanzo's TS apps (esign, console,
  platform), using native ZAP RPC over WebSocket instead of JSON-over-HTTP.
- An **isomorphic transport** — the same `WsTransport` works in Node (post
  HTTP-upgrade, over the `ws` package) and in the browser (native `WebSocket`).
- A Node **`serve(httpServer, opts)`** harness that attaches to an existing
  `http.Server`, so Next.js (`app.getRequestHandler()`) or a Remix Node server
  share one port — integration is one line.
- A browser **`connect(url, opts)`** that opens the WS, waits for `open`, and
  returns the bootstrap call surface typed by your generated bindings.
- A **`mintCap` boundary hook** at the WS upgrade so apps plug their own
  bearer→context minting logic.

## What @zap-proto/web is NOT

- ❌ **Not a Zod/procedure DSL** like tRPC. Service shape comes from `.zap`
  schemas (`struct`s + method ordinals), codegen'd via
  `zapgen --target=ts` from [`zap-proto/ts`](https://github.com/zap-proto/ts).
- ❌ **Not a JSON wrapper.** Wire format is ZAP envelopes over WS **binary**
  messages. Text frames are a protocol violation and close the socket with WS
  code `1003`.
- ❌ **Not Cap'n Proto.** ZAP is its own zero-copy format. The bootstrap is the
  connection's call surface (`bootstrap.call(method, { payload })`), not a
  Cap'n Proto capability object.
- ❌ **Not a bearer-JWT framework.** `mintCap` is a **slot** — apps provide a fn
  `(upgradeReq) => Promise<Ctx | null>`. `v0` ships the slot; the canonical
  ML-DSA-65 signed `Capability` mint (per
  [`zap-spec/capabilities.zap`](https://github.com/zap-proto/spec) — the
  3408-byte signature footer, BLAKE3 identity, attenuable/revocable authority)
  lands in a later version. Until then, whatever non-null value `mintCap`
  returns becomes the per-connection `ctx`.

## Install

```sh
pnpm i @zap-proto/web @zap-proto/zap
```

> `@zap-proto/zap` is not yet published to npm. The `dependencies` entry already
> ships plain semver (`^0.1.0`); until it lands on npm, local tests resolve the
> specifier to the sibling source tree (`../ts`, the `zap-proto/ts` repo) via the
> `vitest.config.ts` alias and the `tsconfig.json` path. No change needed once
> `@zap-proto/zap` ships — just drop the alias.

## Quick start — Next.js (≈30 lines)

```ts
// server.ts
import http from "node:http";
import next from "next";
import { serve } from "@zap-proto/web/server";
import { newGreeting, HelloArgs } from "./gen/hello_zap.js"; // zapgen --target=ts

const app = next({ dev: process.env.NODE_ENV !== "production" });
const handle = app.getRequestHandler();

await app.prepare();
const server = http.createServer((req, res) => handle(req, res));

serve(server, {
  path: "/zap",
  // mintCap SLOT: turn a bearer into your app's ctx. Return null → HTTP 401.
  mintCap: async (req) => {
    const auth = req.headers.authorization;
    return auth ? { org: await orgFromBearer(auth) } : null;
  },
  // rootCap(ctx): dispatch every decoded ZAP Call for this connection.
  rootCap: (ctx) => (call) => {
    const args = HelloArgs.wrap(call.payload);
    return {
      status: 200,
      promiseID: call.promiseID,
      body: newGreeting({ text: `hi ${args.name} @ ${ctx.org}` }),
    };
  },
});

server.listen(3000);
```

```ts
// client.ts (browser)
import { connect } from "@zap-proto/web/client";
import { newHelloArgs, Greeting } from "./gen/hello_zap.js";

const { bootstrap, close } = await connect("wss://app.hanzo.ai/zap", {
  bearer: sessionToken, // forwarded as Authorization on the upgrade (Node ws)
});

const resp = await bootstrap.call(/* method */ 0, {
  payload: newHelloArgs({ name: "ada" }),
});
console.log(Greeting.wrap(resp.body).text); // "hi ada @ acme"
close();
```

> **Browser bearer caveat.** The browser's native `WebSocket` cannot set an
> `Authorization` header. In the browser, `connect({ bearer })` falls back to a
> `?authorization=Bearer%20…` query param the server can read; prefer a cookie
> sent automatically on the upgrade for production. The header path applies to a
> header-capable `WebSocketImpl` (the `ws` package, used in Node/SSR/tests).

## Schema → code

Service shape is `.zap` schemas compiled with the ZAP compiler from
[`zap-proto/ts`](https://github.com/zap-proto/ts):

```sh
zapgen --target=ts -single hello.zap   # → hello_zap.ts (views + builders)
```

Method ordinals (the interface method `@n`) are the integers you pass to
`bootstrap.call(method, …)` and match in your `rootCap` dispatch.

## Entry points

The root entry (`@zap-proto/web`) is **browser-safe** — it imports no Node
built-ins and exposes only the client surface (`connect`, `browserWsTransport`,
`Conn`, errors). The Node server (`serve`, `nodeWsTransport`, the `MintCap`
auth slot) reaches `node:module` (`createRequire`) / `node:http` / `node:net`
and lives behind `@zap-proto/web/server`, so it never enters a browser bundle.

```ts
// Browser — the client connection.
import { connect } from "@zap-proto/web/client";

// Node — attach the RPC endpoint to an http.Server.
import { serve } from "@zap-proto/web/server";
```

## API

| Export | Entry | Purpose |
| --- | --- | --- |
| `connect(url, opts?)` | `@zap-proto/web/client` (or root) | Open a ZAP RPC WebSocket; returns `{ bootstrap, close }`. |
| `browserWsTransport(ws)` | `@zap-proto/web/transport` (or root) | Wrap a native WebSocket as a `WsTransport`. |
| `Conn`, `WebRpcError` | `@zap-proto/web` (root, browser-safe) | Duplex RPC connection; transport-level RPC failure. |
| `serve(httpServer, opts)` | `@zap-proto/web/server` | **Node only.** Attach a ZAP RPC endpoint to a Node `http.Server`. |
| `nodeWsTransport(ws)` | `@zap-proto/web/server` (or `/transport`) | **Node only.** Wrap a `ws` WebSocket as a `WsTransport`. |
| `MintCap<Ctx>` | `@zap-proto/web/server` (or `/auth`) | **Node only.** The bearer→ctx slot. |

## License

MIT © Lux Industries Inc.
