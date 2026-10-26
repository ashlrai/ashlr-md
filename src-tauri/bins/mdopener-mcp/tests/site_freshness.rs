//! The landing page carries machine-readable claims generated from this
//! crate's tool registry and `tauri.conf.json` (`data-app-version`,
//! `data-mcp-tool-count`, `data-mcp-tools`). When they drift, regenerate
//! `landing/index.html` with `node landing/freshness.mjs`. The same file is
//! checked end to end by `src/siteFreshness.test.ts`, which runs under
//! `bun run test` for JS-side changes; this covers the Rust lane, where a
//! registry change lands.

use mdopener_mcp::tool_registry;
use std::fs;
use std::path::PathBuf;

fn repo_file(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn landing() -> String {
    repo_file("landing/index.html")
}

fn attr<'a>(html: &'a str, name: &str) -> &'a str {
    html.split(&format!("{name}=\""))
        .nth(1)
        .and_then(|s| s.split('"').next())
        .unwrap_or_else(|| panic!("landing/index.html has no {name} attribute"))
}

#[test]
fn tool_count_and_names_match_the_registry() {
    let html = landing();
    let names: Vec<&str> = tool_registry().iter().map(|t| t.name).collect();
    let count: usize = attr(&html, "data-mcp-tool-count")
        .parse()
        .expect("data-mcp-tool-count must be a number");
    assert_eq!(
        count,
        names.len(),
        "landing/index.html is stale: run `node landing/freshness.mjs`"
    );
    assert_eq!(
        attr(&html, "data-mcp-tools"),
        names.join(" "),
        "landing/index.html is stale: run `node landing/freshness.mjs`"
    );
    assert!(
        html.contains(&format!("{} tools available", names.len())),
        "landing/index.html is stale: run `node landing/freshness.mjs`"
    );
}

#[test]
fn version_matches_tauri_conf() {
    let html = landing();
    let conf = repo_file("src-tauri/tauri.conf.json");
    let version = conf
        .split("\"version\": \"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .expect("tauri.conf.json has no version");
    assert_eq!(
        attr(&html, "data-app-version"),
        version,
        "landing/index.html is stale: run `node landing/freshness.mjs`"
    );
    assert!(
        html.contains(&format!("v{version}")),
        "landing/index.html does not show v{version}"
    );
}
