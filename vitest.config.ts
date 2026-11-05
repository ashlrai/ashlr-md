import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    // DOM/editor suites need CPU headroom to meet their real-time deadlines.
    // Avoid starting one heavy worker per core on shared development machines.
    maxWorkers: 1,
    minWorkers: 1,
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
