import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Build once before CLI workers start. Per-file builds compete for Cargo's
// target lock and charge time spent waiting against each test's deadline.
export default function buildTestCli() {
  const workspace = resolve(__dirname, "../../src-tauri");
  const target = resolve(workspace, "target");
  execFileSync(
    "cargo",
    ["build", "--locked", "--target-dir", target, "-p", "mdopen", "-p", "mdopener-mcp"],
    { cwd: workspace, stdio: "pipe", timeout: 300_000 },
  );
}
