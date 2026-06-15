import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// @hanzo/zap is not published to npm yet, so the dependency is linked to the
// sibling source tree (../zap-ts). Under test we resolve the "@hanzo/zap"
// specifier to that source directly — the runtime under test is exactly what
// ships. Mirrors zap-ts's own self-hosting alias (capnp-es → ./src).
// TODO: flip to plain npm semver resolution once @hanzo/zap is published.
export default defineConfig({
  resolve: {
    alias: {
      "@hanzo/zap": fileURLToPath(
        new URL("../zap-ts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
