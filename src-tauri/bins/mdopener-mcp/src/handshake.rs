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
            "agent-setup"
        ],
        "health": {
            // The server runs without the app; several tools then answer from disk.
            "status": "ok",
            "checks": [
                { "id": "app-running", "status": if app_running { "ok" } else { "absent" } }
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
