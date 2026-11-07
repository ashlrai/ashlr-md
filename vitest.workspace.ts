import { configDefaults, defineWorkspace } from "vitest/config";
import config from "./vitest.config";

const cliTests = [
  "src/cliHelp.test.ts",
  "src/cliVersion.test.ts",
  "test/cli-no-args.test.ts",
  "test/cli-unknown-flag.test.ts",
];

export default defineWorkspace([
  {
    test: {
      ...config.test,
      name: "unit",
      exclude: [...configDefaults.exclude, ...cliTests],
    },
  },
  {
    test: {
      name: "cli",
      environment: "node",
      include: cliTests,
      globalSetup: ["./scripts/ci/build-test-cli.ts"],
    },
  },
]);
