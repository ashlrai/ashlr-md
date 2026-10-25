//! Handshake conformance kit: validates `mdopener-mcp --ashlr-handshake --json`
//! against the vendored Ashlr handshake v1 contract
//! (tests/contract/ashlr-handshake.v1.json, canonical copy in ashlr-stack's
//! contract/ directory, pinned here by sha256 so no network fetch is needed),
//! and runs the argv mapped to every gated capability mdopener-mcp advertises.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::process::Command;

const CONTRACT: &str = include_str!("contract/ashlr-handshake.v1.json");
const CONTRACT_SHA: &str = include_str!("contract/ashlr-handshake.v1.json.sha256");
const PINNED_SHA256: &str = "e4fa6e79ae7523fb11c44fc16843f0edf385f6c8e4c164409a62d05a76e0ac95";
const KEBAB: &str = "^[a-z0-9]+(-[a-z0-9]+)*$";
const SEMVER: &str = "^[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.+-]+)?$";

fn kebab(s: &str) -> bool {
    !s.is_empty()
        && s.split('-').all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

fn semver(s: &str) -> bool {
    let (core, rest) = match s.find(['-', '+']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let nums: Vec<&str> = core.split('.').collect();
    nums.len() == 3
        && nums
            .iter()
            .all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        && rest.is_none_or(|r| {
            !r.is_empty()
                && r.chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".+-".contains(c))
        })
}

fn matches(pattern: &str, s: &str) -> bool {
    match pattern {
        KEBAB => kebab(s),
        SEMVER => semver(s),
        other => panic!("contract pattern {other} is new; teach this test about it"),
    }
}

/// Problems with `h` under the contract; empty means it conforms.
fn check(h: &Value, c: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for (key, rule) in c["fields"].as_object().unwrap() {
        let Some(v) = h.get(key) else {
            out.push(format!("missing field {key}"));
            continue;
        };
        let ok_type = match rule["type"].as_str().unwrap() {
            "string" => v.is_string(),
            "integer" => v.is_i64() || v.is_u64(),
            "object" => v.is_object(),
            "array" => v.is_array(),
            t => panic!("unknown type {t}"),
        };
        if !ok_type {
            out.push(format!("{key} has the wrong type"));
            continue;
        }
        if let Some(k) = rule.get("const") {
            if v != k {
                out.push(format!("{key} must be {k}"));
            }
        }
        let pattern = rule["pattern"].as_str();
        if let (Some(p), Some(s)) = (pattern, v.as_str()) {
            if !matches(p, s) {
                out.push(format!("{key} does not match {p}"));
            }
        }
        if let Some(o) = v.as_object() {
            if rule["values"] == "integer" && !o.values().all(|n| n.is_i64() || n.is_u64()) {
                out.push(format!("{key} values must be integers"));
            }
            for k in rule["required_keys"].as_array().into_iter().flatten() {
                if !o.contains_key(k.as_str().unwrap()) {
                    out.push(format!("{key} must include {k}"));
                }
            }
        }
        if let Some(a) = v.as_array() {
            for item in a {
                let Some(s) = item.as_str() else {
                    out.push(format!("{key} items must be strings"));
                    continue;
                };
                if pattern.is_some_and(|p| !matches(p, s)) {
                    out.push(format!("{key} item {s} does not match"));
                }
                if rule["not_prefix"]
                    .as_str()
                    .is_some_and(|p| s.starts_with(p))
                {
                    out.push(format!("{key} item {s} is absolute"));
                }
            }
            if rule["unique"] == true {
                let mut seen = std::collections::HashSet::new();
                if !a.iter().all(|x| seen.insert(x.to_string())) {
                    out.push(format!("{key} has duplicates"));
                }
            }
        }
    }
    let hc = &c["health"];
    let enum_has = |list: &Value, s: &Value| list.as_array().unwrap().contains(s);
    if !enum_has(&hc["status"], &h["health"]["status"]) {
        out.push("health.status not in the contract enum".into());
    }
    let checks = h["health"]["checks"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for ck in &checks {
        if !ck["id"]
            .as_str()
            .is_some_and(|s| matches(hc["check_id_pattern"].as_str().unwrap(), s))
        {
            out.push("health check id is not kebab-case".into());
        }
        if !enum_has(&hc["check_status"], &ck["status"]) {
            out.push(format!("health check {} has an unknown status", ck["id"]));
        }
    }
    if hc["missing_means_not_ok"] == true
        && h["health"]["status"] == "ok"
        && checks.iter().any(|c| c["status"] == "missing")
    {
        out.push("health.status is ok while a check is missing".into());
    }
    out
}

fn contract() -> Value {
    serde_json::from_str(CONTRACT).unwrap()
}

fn handshake(home: &std::path::Path) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .args(["--ashlr-handshake", "--json"])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success());
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn vendored_contract_matches_the_pin() {
    let sha: String = Sha256::digest(CONTRACT.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        sha, PINNED_SHA256,
        "re-vendor contract/ashlr-handshake.v1.json from ashlr-stack and update the pin"
    );
    assert_eq!(CONTRACT_SHA.split_whitespace().next(), Some(PINNED_SHA256));
}

#[test]
fn mdopener_mcp_handshake_conforms() {
    let home = tempfile::tempdir().unwrap();
    let h = handshake(home.path());
    assert_eq!(check(&h, &contract()), Vec::<String>::new());
}

/// Every gated capability mdopener-mcp advertises runs its contract argv: exit code
/// and output shape as promised, read-only (nothing created in a fresh home).
#[test]
fn advertised_gated_capabilities_run_their_contract_argv() {
    let home = tempfile::tempdir().unwrap();
    let h = handshake(home.path());
    let c = contract();
    let caps = h["capabilities"].as_array().unwrap();
    let mut ran = 0;
    for (cap, g) in c["gated_capabilities"].as_object().unwrap() {
        if !caps.iter().any(|x| x == cap) {
            continue;
        }
        let argv: Vec<&str> = g["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        let out = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
            .args(&argv)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", home.path())
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        let code = out.status.code().unwrap_or(-1) as i64;
        assert!(
            g["exit_codes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e == code),
            "{cap}: exit {code}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let v: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|_| panic!("{cap}: stdout is not JSON"));
        for k in g["stdout_json_keys"].as_array().unwrap() {
            assert!(
                v.get(k.as_str().unwrap()).is_some(),
                "{cap}: output lacks {k}"
            );
        }
        if g["read_only"] == true {
            assert_eq!(
                std::fs::read_dir(home.path()).unwrap().count(),
                0,
                "{cap}: preview wrote to HOME"
            );
        }
        ran += 1;
    }
    assert!(
        ran >= 1,
        "mdopener-mcp advertises doctor-fix, so at least one gated run is expected"
    );
}

#[test]
fn the_checker_catches_drift() {
    let home = tempfile::tempdir().unwrap();
    let good = handshake(home.path());
    let c = contract();
    let bad = |k: &str, v: Value| {
        let mut h = good.clone();
        h[k] = v;
        check(&h, &c)
    };
    assert!(!bad("kind", "x".into()).is_empty());
    assert!(!bad("schema_version", 2.into()).is_empty());
    assert!(!bad("version", "v1".into()).is_empty());
    assert!(!bad("capabilities", serde_json::json!(["Doctor_Fix"])).is_empty());
    assert!(!bad("capabilities", serde_json::json!(["a", "a"])).is_empty());
    assert!(!bad("edits", serde_json::json!(["/etc"])).is_empty());
    assert!(!bad(
        "health",
        serde_json::json!({"status": "ok", "checks": [{"id": "x", "status": "missing"}]})
    )
    .is_empty());
    let mut h = good.clone();
    h.as_object_mut().unwrap().remove("receipts");
    assert_eq!(check(&h, &c), vec!["missing field receipts".to_string()]);
}
