import { defineConfig } from "vitest/config";

// @zap-proto/zap is resolved from npm (^1.1.0). The runtime under test is
// exactly what ships to consumers — no source alias, no link override.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
