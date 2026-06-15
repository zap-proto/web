import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// @zap-proto/zap is not published to npm yet, so the dependency is resolved to
// the sibling source tree (../ts, the zap-proto/ts repo). Under test we resolve
// the "@zap-proto/zap" specifier to that source directly — the runtime under
// test is exactly what ships. Mirrors zap-proto/ts's own self-hosting alias.
// TODO: flip to plain npm semver resolution once @zap-proto/zap is published.
export default defineConfig({
  resolve: {
    alias: {
      "@zap-proto/zap": fileURLToPath(
        new URL("../ts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
