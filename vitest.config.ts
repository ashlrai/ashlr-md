import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    // DOM-heavy editor suites contend for CPU when every core gets a worker.
    // Bound parallelism so real timers keep headroom under the budget below.
    maxWorkers: 2,
    minWorkers: 1,
    // Milkdown/Crepe mounts take seconds when a shared CI or fleet host is
    // starved of CPU, so the 5 s default expired on healthy code. A passing
    // test never waits for this; only a real hang does.
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
