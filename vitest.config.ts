import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    server: {
      deps: {
        // Transform this ESM script so its fs imports honor test fixtures.
        inline: [/\/scripts\/tool-path\.mjs$/],
      },
    },
  },
});
