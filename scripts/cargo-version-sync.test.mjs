import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Extract version from the [package] section of a Cargo.toml file.
 * Returns undefined when the key is missing or the value is empty.
 */
function extractCargoVersion(filePath) {
  const text = readFileSync(filePath, "utf8");
  // Locate the [package] section header.
  const packageStart = text.indexOf("[package]");
  if (packageStart === -1) return undefined;
  // Slice everything after the header.
  const rest = text.slice(packageStart + "[package]".length);
  // Find the next section header (another [...] at the start of a line).
  const sectionEndMatch = rest.match(/^\r?\n(?=\[[\w-]+\])/m);
  // If no next section exists, the body runs to end of file.
  const sectionBody = sectionEndMatch ? rest.slice(0, sectionEndMatch.index) : rest;
  const versionMatch = sectionBody.match(/^\s*version\s*=\s*"([^"]*)"/m);
  if (!versionMatch) return undefined;
  return versionMatch[1] || undefined;
}

function checkVersions(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const cargoVer = extractCargoVersion(join(dir, "src-tauri/Cargo.toml"));
  const packageVersion = pkg.version;
  const ok =
    typeof packageVersion === "string" &&
    packageVersion !== "" &&
    typeof cargoVer === "string" &&
    cargoVer !== "" &&
    packageVersion === cargoVer;
  const message = ok
    ? `ok: ${packageVersion}`
    : `version mismatch: package.json is ${JSON.stringify(packageVersion)} but src-tauri/Cargo.toml package.version is ${JSON.stringify(cargoVer)}. Set both to the same version.`;
  return { ok, message };
}

function fixture(pkgVersion, cargoVersion) {
  const dir = mkdtempSync(join(tmpdir(), "cargover-"));
  mkdirSync(join(dir, "src-tauri"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: pkgVersion }));
  const esc = String.fromCharCode(34);
  const cargoTmpl = "[package]\nname = " + esc + "x" + esc + "\nversion = " + JSON.stringify(cargoVersion ?? "none") + "\n";
  writeFileSync(join(dir, "src-tauri/Cargo.toml"), cargoTmpl);
  return dir;
}

test("the repo's package.json and Cargo.toml [package] version match", () => {
  const r = checkVersions(root);
  assert.equal(r.ok, true, r.message);
});

test("the CLI package versions match package.json", () => {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const name of ["mdopen", "mdopener-mcp"]) {
    const manifest = join(root, "src-tauri", "bins", name, "Cargo.toml");
    assert.equal(extractCargoVersion(manifest), version, `${name} version must match package.json`);
  }
});

test("matching versions pass", () => {
  const dir = fixture("1.2.3", "1.2.3");
  try {
    assert.equal(checkVersions(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("mismatched versions fail and name both values", () => {
  const dir = fixture("1.2.3", "1.2.4");
  try {
    const r = checkVersions(dir);
    assert.equal(r.ok, false);
    assert.match(r.message, /"1\.2\.3".*"1\.2\.4"/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a missing version on either side fails, even when both are missing", () => {
  for (const [pkgV, cargoV] of [[undefined, undefined], ["1.0.0", undefined], [undefined, "1.0.0"], ["", ""]]) {
    const dir = fixture(pkgV, cargoV);
    try {
      assert.equal(checkVersions(dir).ok, false, `package=${pkgV} cargo=${cargoV}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});
