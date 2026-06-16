// Copyright (C) 2025, Lux Industries Inc. All rights reserved.
// See the file LICENSE for licensing terms.

/**
 * @vitest-environment happy-dom
 *
 * Browser-safety guard for the @zap-proto/web root entry (FIX 2).
 *
 * The root entry must import zero Node built-ins so it bundles into a browser.
 * `serve` / `nodeWsTransport` / the `MintCap` auth slot reach `node:module`
 * (createRequire) / `node:http` / `node:net` and now live ONLY behind
 * `@zap-proto/web/server`. We assert:
 *
 *   1. `await import("../src/index.js")` resolves under a DOM environment and
 *      exposes the browser RPC surface (connect / browserWsTransport / Conn).
 *   2. The server-only symbols are NOT reachable from root.
 *   3. The BUILT root bundle (dist/index.js) imports no `node:` builtin and
 *      never names `createRequire`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/** Strip `//` line comments and `/* *\/` block comments from JS source. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("@zap-proto/web root is browser-safe (FIX 2)", () => {
  it("imports under a DOM environment with no resolution error", async () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe(
      "object",
    );
    const mod = await import("../src/index.js");
    // Browser RPC surface is present...
    expect(typeof mod.connect).toBe("function");
    expect(typeof mod.browserWsTransport).toBe("function");
    expect(typeof mod.Conn).toBe("function");
    expect(typeof mod.WebRpcError).toBe("function");
    // ...and the Node server surface is NOT reachable from root.
    const m = mod as Record<string, unknown>;
    expect(m.serve).toBeUndefined();
    expect(m.nodeWsTransport).toBeUndefined();
  });

  it("the server sub-path still exposes serve + node transport", async () => {
    const server = await import("../src/server.js");
    expect(typeof server.serve).toBe("function");
    expect(typeof server.nodeWsTransport).toBe("function");
  });

  it("built dist/index.js imports no Node built-in", () => {
    // Resolve from cwd: import.meta.url is an http:// URL under happy-dom.
    const dist = join(process.cwd(), "dist", "index.js");
    if (!existsSync(dist)) return; // dist is produced by `pnpm build`.
    // Strip comments so prose mentioning `node:` / `createRequire` in JSDoc
    // does not trip the guard — we are checking emitted code, not docs.
    const code = stripComments(readFileSync(dist, "utf8"));
    expect(/from\s*["']node:/.test(code)).toBe(false);
    expect(/\bcreateRequire\b/.test(code)).toBe(false);
    expect(/from\s*["'](?:net|tls|module|http)["']/.test(code)).toBe(false);
    expect(/\brequire\s*\(/.test(code)).toBe(false);
  });
});
