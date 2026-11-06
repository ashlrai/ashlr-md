import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    pool: "forks",
    include: ["bench/**/*.bench.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 60000,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
