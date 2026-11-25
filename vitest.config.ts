// Unit tests (Vitest). The build-time constant is fixed here so the tests do not depend on version.txt.
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __BUILD_INFO__: JSON.stringify({ id: "v2026.1.2.3.4", channel: "dev" }) },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
