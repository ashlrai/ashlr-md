//! Ashlr companion handshake v1 (`mdopener-mcp --ashlr-handshake [--json]`):
//! one JSON object naming the server, its protocols and capabilities, local
//! health and the files Ashlr MD may edit, so `phm companions` /
//! `phm doctor` stop guessing from `--help`. Same shape as locus,
//! ashlr-stack, ashlr-plugin and lexicon; contract: docs/ashlr-handshake.md.
//!
//! Answered before stdin is read: no network, no IPC token read, no
//! document contents. Health is one existence check.

use serde_json::{json, Value};

pub const FLAG: &str = "--ashlr-handshake";

pub fn build(version: &str, app_running: bool) -> Value {
    build_with(version, app_running, "absent")
}

/// [`build`] with the `local-inference-config` check status (`ok`, `absent`
/// or `missing`), computed from `~/.ashlr/config.json` only, never a probe
/// (as in phantom #920). `missing` (an invalid block) makes health `degraded`.
pub fn build_with(version: &str, app_running: bool, local_inference_config: &str) -> Value {
    json!({
        "kind": "ashlr.handshake",
        "schema_version": 1,
        "name": "ashlr-md",
        "command": "mdopener-mcp",
        "version": version,
        "protocols": { "ashlr.handshake": 1, "mcp": 1 },
        "capabilities": [
            "mcp-server",
            "markdown-viewer",
            "review-annotations",
            "document-edit",
            "export",
            "vault-search",
            "agent-setup",
            "doctor-fix",
            "local-inference-probe"
        ],
        "health": {
            // The server runs without the app; several tools then answer from disk.
            "status": if local_inference_config == "missing" { "degraded" } else { "ok" },
            "checks": [
                { "id": "app-running", "status": if app_running { "ok" } else { "absent" } },
                { "id": "local-inference-config", "status": local_inference_config }
            ]
        },
        "edits": ["~/.mdopener/", "~/.cursor/mcp.json"],
        "receipts": []
    })
}

/// True when the arguments ask for the handshake (`--json` alongside is accepted).
pub fn requested(args: &[String]) -> bool {
    args.iter().any(|a| a == FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_the_contract() {
        let h = build("1.2.3", true);
        assert_eq!(h["kind"], "ashlr.handshake");
        assert_eq!(h["schema_version"], 1);
        assert_eq!(h["name"], "ashlr-md");
        assert_eq!(h["command"], "mdopener-mcp");
        assert_eq!(h["version"], "1.2.3");
        assert_eq!(h["health"]["status"], "ok");
        assert_eq!(h["health"]["checks"][0]["status"], "ok");
    }

    #[test]
    fn local_inference_config_check_mirrors_920() {
        let h = build_with("1", true, "ok");
        assert!(h["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == "local-inference-probe"));
        assert_eq!(h["health"]["checks"][1]["id"], "local-inference-config");
        assert_eq!(h["health"]["checks"][1]["status"], "ok");
        assert_eq!(h["health"]["status"], "ok");
        assert_eq!(build_with("1", true, "absent")["health"]["status"], "ok");
        let bad = build_with("1", true, "missing");
        assert_eq!(bad["health"]["status"], "degraded");
        assert_eq!(bad["health"]["checks"][1]["status"], "missing");
    }

    #[test]
    fn app_not_running_is_informational() {
        let h = build("1", false);
        assert_eq!(h["health"]["status"], "ok");
        assert_eq!(h["health"]["checks"][0]["status"], "absent");
    }

    #[test]
    fn ids_are_kebab_case_and_edits_are_relative_or_home() {
        let h = build("1", true);
        let kebab = |s: &str| {
            !s.is_empty()
                && !s.starts_with('-')
                && !s.ends_with('-')
                && s.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        };
        for c in h["capabilities"].as_array().unwrap() {
            assert!(kebab(c.as_str().unwrap()), "{c}");
        }
        for c in h["health"]["checks"].as_array().unwrap() {
            assert!(kebab(c["id"].as_str().unwrap()));
        }
        for e in h["edits"].as_array().unwrap() {
            assert!(!e.as_str().unwrap().starts_with('/'));
        }
    }

    #[test]
    fn only_the_exact_flag_asks() {
        assert!(requested(&["--ashlr-handshake".into(), "--json".into()]));
        assert!(!requested(&["--json".into()]));
        assert!(!requested(&["--ashlr-handshake-x".into()]));
    }
}
