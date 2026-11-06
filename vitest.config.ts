import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    // DOM-heavy editor suites contend for CPU when every core gets a worker.
    // Bound parallelism so real timers retain the default five-second budget.
    maxWorkers: 2,
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
