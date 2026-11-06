import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const prefix = "@tauri-apps/plugin-";

function missingPlugins(dependencies, cargoToml) {
  const lines = cargoToml.split(/\r?\n/);
  return Object.keys(dependencies)
    .filter((name) => name.startsWith(prefix))
    .filter((name) => !lines.some((line) => line.startsWith(`tauri-plugin-${name.slice(prefix.length)} =`)));
}

test("every JavaScript Tauri plugin has a Cargo dependency", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const cargoToml = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  assert.deepEqual(missingPlugins(pkg.dependencies, cargoToml), [], "Missing Tauri plugin dependencies in src-tauri/Cargo.toml");
});

test("only exact plugin dependency lines satisfy the check", () => {
  const dependencies = { "@tauri-apps/plugin-dialog": "2", "@tauri-apps/api": "2" };
  assert.deepEqual(missingPlugins(dependencies, 'tauri-plugin-dialog = "2"\n'), []);
  for (const line of ['# tauri-plugin-dialog = "2"', 'tauri-plugin-dialog-extra = "2"', ' tauri-plugin-dialog = "2"']) {
    assert.deepEqual(missingPlugins(dependencies, line), ["@tauri-apps/plugin-dialog"]);
  }
});
