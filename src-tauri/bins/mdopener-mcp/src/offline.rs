//! Offline flagship, steps c and d. Built around the probe in
//! `local_inference_probe.rs` (owner-reviewed, not changed here): every
//! network request below is that probe, with its rules (loopback only, no
//! key, 3 s, redirects refused, 256 KiB cap, value-free result).
//!
//! - `mdopener-mcp setup --local [--json]` looks for Ollama and oMLX on their
//!   default loopback ports, probes the `localInference` block in
//!   `~/.ashlr/config.json` when there is one, and prints the exact commands
//!   to finish: the model pull, the config block, the check. It downloads
//!   nothing and writes nothing. A model is several GB, so the pull is printed
//!   for the user to run; it is never started here.
//! - `mdopener-mcp doctor [--json]` gains a second check, `offline`:
//!   `verified` when `localInference.offline` is on, the configured server is
//!   loopback and it answered the probe (so no remote endpoint is in use and
//!   cloud AI is refused), `unverified` when offline is on but no local server
//!   answered, `not-enabled` when offline is off.
//!
//! Output stays value-free like the probe: never a URL from the config, never
//! a model name read from a server. The fixed default base URLs and the
//! configured model name appear only in the commands the user is asked to run.

use crate::local_inference_probe::{self as probe, gate, ProbeResult, PROBE_TIMEOUT};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

pub const OFFLINE_CHECK_ID: &str = "offline";
pub const SETUP_KIND: &str = "ashlr.setup-local";

/// The servers `setup --local` looks for, at the gate's default base URLs
/// (`provider_default_base_url` there; a unit test keeps the two in step).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultServer {
    pub provider: &'static str,
    pub base_url: &'static str,
}

pub const DEFAULT_SERVERS: [DefaultServer; 2] = [
    DefaultServer {
        provider: "ollama",
        base_url: "http://127.0.0.1:11434/v1",
    },
    DefaultServer {
        provider: "omlx",
        base_url: "http://127.0.0.1:8000/v1",
    },
];

// ---------------------------------------------------------------------------
// Step d: the `offline` doctor check.
// ---------------------------------------------------------------------------

/// The `offline` check: a closed status, its envelope level and a value-free
/// summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineCheck {
    /// verified | unverified | not-enabled
    pub status: &'static str,
    /// ashlr.doctor check status: ok | warn | info
    pub level: &'static str,
    pub summary: String,
}

/// [`offline_verdict`] from a probe result.
pub fn offline_check(offline: bool, p: &ProbeResult) -> OfflineCheck {
    offline_verdict(offline, p.status, p.provider.as_deref(), p.loopback)
}

/// Decide the `offline` check from the config flag and the probe's status,
/// provider and loopback flag. "No remote endpoint is used" holds because the
/// gate forces `allowRemote` off when `offline` is on (a remote base URL is
/// then `config-invalid`, never probed) and the probe itself refuses any
/// non-loopback host; the loopback flag is still checked here, never assumed.
pub fn offline_verdict(
    offline: bool,
    probe_status: &str,
    provider: Option<&str>,
    loopback: bool,
) -> OfflineCheck {
    if !offline {
        return OfflineCheck {
            status: "not-enabled",
            level: "info",
            summary: "not enabled: cloud AI stays available; set \"offline\": true on localInference in ~/.ashlr/config.json to allow loopback only".into(),
        };
    }
    let provider = provider.unwrap_or("local server");
    if probe_status == "reachable" && loopback {
        return OfflineCheck {
            status: "verified",
            level: "ok",
            summary: format!(
                "verified: {provider} answered on loopback and no remote endpoint is used; cloud AI is disabled"
            ),
        };
    }
    let why = match probe_status {
        "config-invalid" => "localInference is invalid, so no local server is used".to_string(),
        "unreachable" => format!("{provider} did not answer on loopback"),
        "bad-response" => format!("{provider} answered but not with a model list"),
        "remote-not-probed" => format!("{provider} is a remote endpoint, which offline refuses"),
        other => format!("{provider}: {other}"),
    };
    OfflineCheck {
        status: "unverified",
        level: "warn",
        summary: format!(
            "unverified: {why}; cloud AI is disabled, so AI is unavailable until a loopback server answers (run `mdopener-mcp setup --local`)"
        ),
    }
}

/// The native text level for the local-inference line: the same table as
/// the probe's own doctor (`ok` for not-configured and reachable, `warn` for
/// everything else, never fail).
fn native_level(probe_status: &str) -> &'static str {
    match probe_status {
        "not-configured" | "reachable" => "ok",
        _ => "warn",
    }
}

/// The ashlr.doctor v1 top-level status over the checks: any fail is fail,
/// else any warn is warn, else ok. `info` checks never raise it.
fn worst_status(checks: &[Value]) -> &'static str {
    let has = |s: &str| checks.iter().any(|c| c["status"] == s);
    if has("fail") {
        "fail"
    } else if has("warn") {
        "warn"
    } else {
        "ok"
    }
}

/// `mdopener-mcp doctor [--json]`: the local-inference check as before, plus
/// the `offline` check. One probe: the probe's doctor runs it and reports it
/// as JSON, which is read back here (structured, unlike its text) so neither
/// the probe nor its summaries are repeated. The `offline` flag is one file
/// read, no network. Exit code 0 as before: a warning never fails doctor.
pub fn doctor(json: bool) -> (String, i32) {
    let (tier1, code) = probe::doctor(true);
    match doctor_with(json, &tier1, gate::offline()) {
        Some(out) => (out, code),
        // Unreachable unless the probe's JSON changes shape; then its own
        // output stands, without the offline line.
        None => probe::doctor(json),
    }
}

/// [`doctor`] on a given `ashlr.doctor` JSON document from the probe and a
/// given `offline` flag. `None` when the document does not have the probe's
/// shape (`checks[0].summary` and `checks[0].probe`).
pub fn doctor_with(json: bool, tier1_json: &str, offline: bool) -> Option<String> {
    let mut v: Value = serde_json::from_str(tier1_json).ok()?;
    let first = v.get("checks")?.get(0)?;
    let summary = first.get("summary")?.as_str()?.to_string();
    let p = first.get("probe")?;
    let status = p.get("status")?.as_str()?.to_string();
    let provider = p
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let loopback = p.get("loopback").and_then(Value::as_bool).unwrap_or(false);
    let off = offline_verdict(offline, &status, provider.as_deref(), loopback);
    if !json {
        return Some(format!(
            "doctor: local-inference [{}] {summary}\ndoctor: {OFFLINE_CHECK_ID} [{}] {}\n",
            native_level(&status),
            off.level,
            off.summary
        ));
    }
    let worst = {
        let checks = v.get_mut("checks")?.as_array_mut()?;
        checks.push(json!({
            "id": OFFLINE_CHECK_ID,
            "status": off.level,
            "native_status": off.status,
            "summary": off.summary,
        }));
        worst_status(checks)
    };
    v["status"] = worst.into();
    Some(format!(
        "{}\n",
        serde_json::to_string(&v).unwrap_or_default()
    ))
}

// ---------------------------------------------------------------------------
// Step c: `setup --local`.
// ---------------------------------------------------------------------------

/// One default server, probed at its fixed base URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFinding {
    pub provider: String,
    /// The fixed default (a constant, never a value from the config).
    pub base_url: String,
    pub probe: ProbeResult,
}

/// The `localInference` block as found: `absent`, `invalid` (the gate
/// refused it; the probe result carries the reason code), or `ok` (probed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFinding {
    /// absent | invalid | ok
    pub status: &'static str,
    pub offline: bool,
    pub provider: Option<String>,
    pub probe: Option<ProbeResult>,
}

/// What to set up: the provider, the model to pull and how.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub provider: String,
    pub model: String,
    pub reachable: bool,
    /// The exact pull command (ollama only; oMLX and openai-compat servers
    /// load models their own way, said in `notes`). Printed, never run.
    pub pull_command: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupReport {
    pub servers: Vec<ServerFinding>,
    pub config: ConfigFinding,
    pub recommended: Recommendation,
    /// JSON to add to `~/.ashlr/config.json`, or `None` when it already has
    /// `offline: true` (or must be fixed first).
    pub config_snippet: Option<Value>,
    pub next: Vec<Step>,
}

fn probe_default(provider: &str, timeout: Duration) -> ProbeResult {
    // The gate supplies the default base URL for the provider.
    probe::probe_config(
        Some(&json!({ "localInference": { "provider": provider } })),
        timeout,
    )
}

/// Probe the default servers and the configured block (`root` is the parsed
/// `~/.ashlr/config.json`), then [`build`] the report. Reads only.
pub fn collect(root: Option<&Value>, timeout: Duration) -> SetupReport {
    let servers: Vec<ServerFinding> = DEFAULT_SERVERS
        .iter()
        .map(|d| ServerFinding {
            provider: d.provider.to_string(),
            base_url: d.base_url.to_string(),
            probe: probe_default(d.provider, timeout),
        })
        .collect();
    collect_with_servers(root, timeout, servers)
}

/// Collect the configured block using supplied default server findings.
/// Callers can inject deterministic findings without contacting fixed ports.
pub fn collect_with_servers(
    root: Option<&Value>,
    timeout: Duration,
    servers: Vec<ServerFinding>,
) -> SetupReport {
    let block = root.and_then(|r| r.get("localInference"));
    let config = match gate::parse_local_inference(block) {
        Ok(None) => ConfigFinding {
            status: "absent",
            offline: false,
            provider: None,
            probe: None,
        },
        // `config-invalid` with the gate's reason code; nothing is contacted.
        Err(_) => ConfigFinding {
            status: "invalid",
            offline: gate::offline_from(root),
            provider: None,
            probe: Some(probe::probe_config(root, timeout)),
        },
        Ok(Some(cfg)) => {
            // A block at a default base URL was just probed: do not ask twice.
            let seen = servers
                .iter()
                .find(|s| s.provider == cfg.provider && s.base_url == cfg.base_url)
                .map(|s| s.probe.clone());
            ConfigFinding {
                status: "ok",
                offline: cfg.offline,
                provider: Some(cfg.provider.clone()),
                probe: Some(seen.unwrap_or_else(|| probe::probe_config(root, timeout))),
            }
        }
    };
    let model = gate::parse_local_inference(block)
        .ok()
        .flatten()
        .map(|c| c.model)
        .unwrap_or_else(|| gate::DEFAULT_LOCAL_MODEL.to_string());
    build(servers, config, model)
}

/// Pure: the recommendation, snippet and next steps from what was found.
pub fn build(servers: Vec<ServerFinding>, config: ConfigFinding, model: String) -> SetupReport {
    let configured = (config.status == "ok")
        .then(|| config.provider.clone())
        .flatten();
    let provider = configured.clone().unwrap_or_else(|| {
        servers
            .iter()
            .find(|s| s.probe.status == "reachable")
            .map(|s| s.provider.clone())
            .unwrap_or_else(|| "ollama".to_string())
    });
    let reachable = match &configured {
        Some(_) => config
            .probe
            .as_ref()
            .is_some_and(|p| p.status == "reachable"),
        None => servers
            .iter()
            .any(|s| s.provider == provider && s.probe.status == "reachable"),
    };
    let mut notes = Vec::new();
    let pull_command = match provider.as_str() {
        "ollama" => {
            if !reachable {
                notes.push(
                    "Ollama is not answering on 127.0.0.1:11434: install it from https://ollama.com and run `ollama serve`, then pull the model.".to_string(),
                );
            }
            Some(format!("ollama pull {model}"))
        }
        "omlx" => {
            if !reachable {
                notes.push(
                    "oMLX is not answering on 127.0.0.1:8000: start it with `omlx serve --model-dir <folder>`.".to_string(),
                );
            }
            notes.push(
                "oMLX has no pull command: download the model in its dashboard (http://127.0.0.1:8000/admin, Model Downloader) or place MLX weights under the folder given to `omlx serve --model-dir`, then set localInference.models.coder to the id it lists at /v1/models.".to_string(),
            );
            None
        }
        _ => {
            notes.push(format!(
                "openai-compat: download `{model}` with your server's own tool, then set localInference.models.coder to the id it lists at /v1/models."
            ));
            None
        }
    };
    let config_snippet = match (config.status, config.offline) {
        ("absent", _) => {
            Some(json!({ "localInference": { "provider": provider, "offline": true } }))
        }
        ("ok", false) => Some(json!({ "offline": true })),
        _ => None,
    };
    let mut next = Vec::new();
    match &pull_command {
        Some(cmd) => next.push(Step {
            text: format!(
                "Pull the model yourself (a download of several GB; setup never starts it). Skip this if `ollama list` already shows {model}:"
            ),
            command: Some(cmd.clone()),
        }),
        None => next.push(Step {
            text: notes
                .last()
                .cloned()
                .unwrap_or_else(|| "Load a model on the server.".to_string()),
            command: None,
        }),
    }
    match (config.status, config.offline) {
        ("absent", _) => next.push(Step {
            text: "Add to ~/.ashlr/config.json (setup writes nothing):".to_string(),
            command: Some(format!(
                "\"localInference\": {{ \"provider\": \"{provider}\", \"offline\": true }}"
            )),
        }),
        ("ok", false) => next.push(Step {
            text: "Add to the existing localInference block in ~/.ashlr/config.json so cloud AI is refused (setup writes nothing):".to_string(),
            command: Some("\"offline\": true".to_string()),
        }),
        ("ok", true) => next.push(Step {
            text: "~/.ashlr/config.json already has localInference.offline: true; nothing to add.".to_string(),
            command: None,
        }),
        _ => next.push(Step {
            text: format!(
                "Fix localInference in ~/.ashlr/config.json first ({}); an invalid block is never used.",
                config
                    .probe
                    .as_ref()
                    .and_then(|p| p.reason.clone())
                    .unwrap_or_else(|| "invalid".to_string())
            ),
            command: None,
        }),
    }
    next.push(Step {
        text: "Check it (expect `doctor: offline [ok] verified`):".to_string(),
        command: Some("mdopener-mcp doctor".to_string()),
    });
    SetupReport {
        servers,
        config,
        recommended: Recommendation {
            provider,
            model,
            reachable,
            pull_command,
            notes,
        },
        config_snippet,
        next,
    }
}

/// One value-free phrase for a probe result.
pub fn describe(p: &ProbeResult) -> String {
    let reason = p.reason.clone().unwrap_or_default();
    match p.status {
        "reachable" => format!("reachable, {} model(s)", p.model_count),
        "unreachable" => format!("not running ({reason})"),
        "bad-response" => format!(
            "bad response ({reason}{})",
            p.http_status
                .map(|c| format!(", HTTP {c}"))
                .unwrap_or_default()
        ),
        "remote-not-probed" => "remote endpoint, not probed (offline needs loopback)".to_string(),
        "config-invalid" => format!("invalid ({reason})"),
        other => other.to_string(),
    }
}

fn describe_config(c: &ConfigFinding) -> String {
    match (c.status, &c.probe) {
        ("absent", _) => "no localInference block".to_string(),
        (_, Some(p)) => {
            let head = match &c.provider {
                Some(provider) => format!("{provider}: {}", describe(p)),
                None => format!("localInference {}", describe(p)),
            };
            format!("{head}; offline: {}", if c.offline { "on" } else { "off" })
        }
        _ => "localInference not read".to_string(),
    }
}

/// The text report. Lines name only constants (default URLs, the config
/// path) and the configured model in its pull command.
pub fn render_text(r: &SetupReport) -> String {
    let mut out = String::from(
        "setup --local: local model servers on loopback (downloads nothing, writes nothing)\n",
    );
    for s in &r.servers {
        out.push_str(&format!(
            "  {:<8} {:<26} {}\n",
            s.provider,
            s.base_url,
            describe(&s.probe)
        ));
    }
    out.push_str(&format!(
        "  {:<8} {:<26} {}\n",
        "config",
        "~/.ashlr/config.json",
        describe_config(&r.config)
    ));
    for note in &r.recommended.notes {
        out.push_str(&format!("  note: {note}\n"));
    }
    out.push_str("next:\n");
    for (i, step) in r.next.iter().enumerate() {
        out.push_str(&format!("  {}. {}\n", i + 1, step.text));
        if let Some(c) = &step.command {
            out.push_str(&format!("       {c}\n"));
        }
    }
    out
}

pub fn render_json(r: &SetupReport) -> String {
    let v = json!({
        "kind": SETUP_KIND,
        "schema_version": 1,
        "tool": "ashlr-md",
        "downloads": false,
        "writes": false,
        "servers": r.servers,
        "config": r.config,
        "recommended": r.recommended,
        "config_snippet": r.config_snippet,
        "next": r.next,
    });
    format!("{}\n", serde_json::to_string(&v).unwrap_or_default())
}

pub const SETUP_HELP: &str = "USAGE:
    mdopener-mcp setup --local [--json]   find Ollama and oMLX on loopback; print the commands to finish

Probes 127.0.0.1:11434 (Ollama, GET /api/tags) and 127.0.0.1:8000 (oMLX,
GET /v1/models), and the localInference block in ~/.ashlr/config.json when
there is one: loopback only, no key, 3 s each, redirects refused. Then it
prints the model pull command, the config block to add and the doctor check.
It downloads nothing and writes nothing: you run the pull yourself.
";

/// Run `mdopener-mcp setup <args>`: (stdout, stderr, exit code). `args` are
/// the arguments after `setup`. Reads `~/.ashlr/config.json` only.
pub fn setup(args: &[String]) -> (String, String, i32) {
    let mut local = false;
    let mut json = false;
    for a in args {
        match a.as_str() {
            "--local" => local = true,
            "--json" => json = true,
            "--help" | "-h" => return (SETUP_HELP.to_string(), String::new(), 0),
            other => {
                return (
                    String::new(),
                    format!("mdopener-mcp setup: unknown argument `{other}`\n{SETUP_HELP}"),
                    2,
                )
            }
        }
    }
    if !local {
        return (SETUP_HELP.to_string(), String::new(), 0);
    }
    let root = gate::read_config_value();
    let report = collect(root.as_ref(), PROBE_TIMEOUT);
    let out = if json {
        render_json(&report)
    } else {
        render_text(&report)
    };
    (out, String::new(), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_result(status: &'static str, provider: Option<&str>, loopback: bool) -> ProbeResult {
        ProbeResult {
            status,
            provider: provider.map(str::to_string),
            loopback,
            reachable: status == "reachable" || status == "bad-response",
            http_status: (status == "reachable").then_some(200),
            model_count: usize::from(status == "reachable"),
            reason: match status {
                "unreachable" => Some("connect-failed".into()),
                "config-invalid" => Some("localInference.baseUrl: remote-not-allowed".into()),
                _ => None,
            },
            bytes_read: 0,
        }
    }

    fn finding(provider: &str, status: &'static str) -> ServerFinding {
        let d = DEFAULT_SERVERS
            .iter()
            .find(|d| d.provider == provider)
            .unwrap();
        ServerFinding {
            provider: provider.into(),
            base_url: d.base_url.into(),
            probe: probe_result(status, Some(provider), true),
        }
    }

    #[test]
    fn default_servers_match_the_gate() {
        for d in DEFAULT_SERVERS {
            let cfg = gate::parse_local_inference(Some(&json!({ "provider": d.provider })))
                .unwrap()
                .unwrap();
            assert_eq!(cfg.base_url, d.base_url, "{}", d.provider);
            assert!(cfg.loopback);
        }
    }

    #[test]
    fn offline_verdict_table() {
        let off = offline_verdict(false, "reachable", Some("ollama"), true);
        assert_eq!((off.status, off.level), ("not-enabled", "info"));
        assert!(off.summary.contains("\"offline\": true"), "{}", off.summary);
        let off = offline_verdict(false, "not-configured", None, false);
        assert_eq!(off.status, "not-enabled");

        let on = offline_verdict(true, "reachable", Some("omlx"), true);
        assert_eq!((on.status, on.level), ("verified", "ok"));
        assert!(
            on.summary
                .starts_with("verified: omlx answered on loopback"),
            "{}",
            on.summary
        );
        assert!(on.summary.contains("no remote endpoint is used"));

        // Reachable but not loopback is never verified (cannot happen through
        // the probe, which refuses non-loopback; still fail closed).
        let bad = offline_verdict(true, "reachable", Some("ollama"), false);
        assert_eq!((bad.status, bad.level), ("unverified", "warn"));

        for status in [
            "unreachable",
            "bad-response",
            "config-invalid",
            "remote-not-probed",
            "not-configured",
        ] {
            let v = offline_verdict(true, status, Some("ollama"), true);
            assert_eq!((v.status, v.level), ("unverified", "warn"), "{status}");
            assert!(v.summary.contains("cloud AI is disabled"), "{status}");
            assert!(v.summary.contains("setup --local"), "{status}");
        }
        let v = offline_check(true, &probe_result("unreachable", Some("ollama"), true));
        assert!(v.summary.contains("ollama did not answer on loopback"));
    }

    fn tier1(status: &str, provider: Option<&str>, loopback: bool, summary: &str) -> String {
        let p = probe_result(
            match status {
                "reachable" => "reachable",
                "unreachable" => "unreachable",
                "config-invalid" => "config-invalid",
                "remote-not-probed" => "remote-not-probed",
                _ => "not-configured",
            },
            provider,
            loopback,
        );
        let envelope = probe::envelope_status(status, native_level(status));
        serde_json::to_string(&json!({
            "kind": "ashlr.doctor", "schema_version": 1, "tool": "ashlr-md",
            "status": envelope, "native_status": status,
            "checks": [{ "id": "local-inference", "status": envelope, "native_status": status, "summary": summary, "probe": p }]
        }))
        .unwrap()
    }

    #[test]
    fn doctor_text_keeps_the_probe_line_and_adds_offline() {
        let t = tier1(
            "not-configured",
            None,
            false,
            "not configured (no localInference in ~/.ashlr/config.json)",
        );
        let out = doctor_with(false, &t, false).unwrap();
        assert_eq!(
            out,
            "doctor: local-inference [ok] not configured (no localInference in ~/.ashlr/config.json)\n\
             doctor: offline [info] not enabled: cloud AI stays available; set \"offline\": true on localInference in ~/.ashlr/config.json to allow loopback only\n"
        );
        let t = tier1(
            "reachable",
            Some("ollama"),
            true,
            "ollama: reachable, 1 model(s)",
        );
        let out = doctor_with(false, &t, true).unwrap();
        assert!(out.starts_with("doctor: local-inference [ok] ollama: reachable, 1 model(s)\n"));
        assert!(out.contains("doctor: offline [ok] verified: ollama answered on loopback"));
        let t = tier1(
            "unreachable",
            Some("ollama"),
            true,
            "ollama: unreachable (connect-failed)",
        );
        let out = doctor_with(false, &t, true).unwrap();
        assert!(out.starts_with("doctor: local-inference [warn] "), "{out}");
        assert!(out.contains("doctor: offline [warn] unverified: "), "{out}");
        // The native level for a refusal stays warn, as in the probe's text.
        let t = tier1("config-invalid", None, false, "config invalid: x");
        let out = doctor_with(false, &t, true).unwrap();
        assert!(out.starts_with("doctor: local-inference [warn] "), "{out}");
    }

    #[test]
    fn doctor_json_appends_the_check_and_never_lowers_the_status() {
        let t = tier1(
            "not-configured",
            None,
            false,
            "not configured (no localInference in ~/.ashlr/config.json)",
        );
        let v: Value = serde_json::from_str(&doctor_with(true, &t, false).unwrap()).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["native_status"], "not-configured");
        assert_eq!(v["checks"][0]["id"], "local-inference");
        assert!(v["checks"][0]["probe"].is_object());
        assert_eq!(v["checks"][1]["id"], OFFLINE_CHECK_ID);
        assert_eq!(v["checks"][1]["status"], "info");
        assert_eq!(v["checks"][1]["native_status"], "not-enabled");
        assert!(v["checks"][1]["summary"].is_string());

        let t = tier1(
            "reachable",
            Some("ollama"),
            true,
            "ollama: reachable, 1 model(s)",
        );
        let v: Value = serde_json::from_str(&doctor_with(true, &t, true).unwrap()).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["checks"][1]["native_status"], "verified");
        assert_eq!(v["checks"][1]["status"], "ok");

        let t = tier1(
            "unreachable",
            Some("ollama"),
            true,
            "ollama: unreachable (connect-failed)",
        );
        let v: Value = serde_json::from_str(&doctor_with(true, &t, true).unwrap()).unwrap();
        assert_eq!(v["status"], "warn");
        assert_eq!(v["checks"][1]["native_status"], "unverified");

        // A refusal stays envelope fail with the offline check alongside.
        let t = tier1("config-invalid", None, false, "config invalid: x");
        let v: Value = serde_json::from_str(&doctor_with(true, &t, true).unwrap()).unwrap();
        assert_eq!(v["status"], "fail");
        assert_eq!(v["checks"][0]["status"], "fail");
        assert_eq!(v["checks"][1]["status"], "warn");
        let t = tier1("remote-not-probed", Some("openai-compat"), false, "remote");
        let v: Value = serde_json::from_str(&doctor_with(true, &t, false).unwrap()).unwrap();
        assert_eq!(v["status"], "fail");
        assert_eq!(v["checks"][1]["native_status"], "not-enabled");
    }

    #[test]
    fn doctor_with_rejects_a_foreign_shape() {
        assert!(doctor_with(true, "not json", false).is_none());
        assert!(doctor_with(true, r#"{"checks":[]}"#, false).is_none());
        assert!(doctor_with(false, r#"{"checks":[{"summary":"x"}]}"#, false).is_none());
    }

    fn absent() -> ConfigFinding {
        ConfigFinding {
            status: "absent",
            offline: false,
            provider: None,
            probe: None,
        }
    }

    #[test]
    fn fresh_machine_recommends_ollama_with_the_exact_pull_and_block() {
        let r = build(
            vec![
                finding("ollama", "unreachable"),
                finding("omlx", "unreachable"),
            ],
            absent(),
            gate::DEFAULT_LOCAL_MODEL.to_string(),
        );
        assert_eq!(r.recommended.provider, "ollama");
        assert!(!r.recommended.reachable);
        assert_eq!(
            r.recommended.pull_command.as_deref(),
            Some("ollama pull qwen3.8:27b")
        );
        assert_eq!(
            r.config_snippet,
            Some(json!({ "localInference": { "provider": "ollama", "offline": true } }))
        );
        let text = render_text(&r);
        assert!(text.starts_with(
            "setup --local: local model servers on loopback (downloads nothing, writes nothing)\n"
        ));
        assert!(
            text.contains("ollama   http://127.0.0.1:11434/v1  not running (connect-failed)\n"),
            "{text}"
        );
        assert!(
            text.contains("omlx     http://127.0.0.1:8000/v1   not running (connect-failed)\n"),
            "{text}"
        );
        assert!(
            text.contains("config   ~/.ashlr/config.json       no localInference block\n"),
            "{text}"
        );
        assert!(text.contains("note: Ollama is not answering on 127.0.0.1:11434: install it from https://ollama.com"), "{text}");
        assert!(
            text.contains("\n       ollama pull qwen3.8:27b\n"),
            "{text}"
        );
        assert!(
            text.contains(
                "\n       \"localInference\": { \"provider\": \"ollama\", \"offline\": true }\n"
            ),
            "{text}"
        );
        assert!(text.contains("\n       mdopener-mcp doctor\n"), "{text}");
        assert_eq!(r.next.len(), 3);
    }

    #[test]
    fn a_running_omlx_is_picked_when_ollama_is_not_and_has_no_pull_command() {
        let r = build(
            vec![
                finding("ollama", "unreachable"),
                finding("omlx", "reachable"),
            ],
            absent(),
            gate::DEFAULT_LOCAL_MODEL.to_string(),
        );
        assert_eq!(r.recommended.provider, "omlx");
        assert!(r.recommended.reachable);
        assert_eq!(r.recommended.pull_command, None);
        assert!(r
            .recommended
            .notes
            .iter()
            .any(|n| n.contains("oMLX has no pull command")));
        assert!(!r
            .recommended
            .notes
            .iter()
            .any(|n| n.contains("not answering")));
        assert_eq!(
            r.config_snippet,
            Some(json!({ "localInference": { "provider": "omlx", "offline": true } }))
        );
        let text = render_text(&r);
        assert!(
            text.contains("omlx     http://127.0.0.1:8000/v1   reachable, 1 model(s)\n"),
            "{text}"
        );
        assert!(!text.contains("ollama pull"), "{text}");
    }

    #[test]
    fn a_configured_block_wins_and_only_offline_is_added() {
        let config = ConfigFinding {
            status: "ok",
            offline: false,
            provider: Some("openai-compat".into()),
            probe: Some(probe_result("reachable", Some("openai-compat"), true)),
        };
        let r = build(
            vec![
                finding("ollama", "reachable"),
                finding("omlx", "unreachable"),
            ],
            config,
            "my-model".into(),
        );
        assert_eq!(r.recommended.provider, "openai-compat");
        assert_eq!(r.recommended.model, "my-model");
        assert!(r.recommended.reachable);
        assert_eq!(r.recommended.pull_command, None);
        assert_eq!(r.config_snippet, Some(json!({ "offline": true })));
        let text = render_text(&r);
        assert!(text.contains("config   ~/.ashlr/config.json       openai-compat: reachable, 1 model(s); offline: off\n"), "{text}");
        assert!(text.contains("\n       \"offline\": true\n"), "{text}");
        assert!(
            text.contains("download `my-model` with your server's own tool"),
            "{text}"
        );
    }

    #[test]
    fn offline_already_on_has_nothing_to_add_and_invalid_asks_for_a_fix() {
        let config = ConfigFinding {
            status: "ok",
            offline: true,
            provider: Some("ollama".into()),
            probe: Some(probe_result("reachable", Some("ollama"), true)),
        };
        let r = build(
            vec![finding("ollama", "reachable")],
            config,
            "qwen3.8:27b".into(),
        );
        assert_eq!(r.config_snippet, None);
        let text = render_text(&r);
        assert!(
            text.contains("already has localInference.offline: true"),
            "{text}"
        );
        assert!(
            text.contains("ollama: reachable, 1 model(s); offline: on"),
            "{text}"
        );

        let config = ConfigFinding {
            status: "invalid",
            offline: true,
            provider: None,
            probe: Some(probe_result("config-invalid", None, false)),
        };
        let r = build(
            vec![finding("ollama", "unreachable")],
            config,
            "qwen3.8:27b".into(),
        );
        assert_eq!(r.config_snippet, None);
        let text = render_text(&r);
        assert!(
            text.contains(
                "localInference invalid (localInference.baseUrl: remote-not-allowed); offline: on"
            ),
            "{text}"
        );
        assert!(text.contains("Fix localInference in ~/.ashlr/config.json first (localInference.baseUrl: remote-not-allowed)"), "{text}");
    }

    #[test]
    fn json_report_says_it_downloads_and_writes_nothing() {
        let r = build(
            vec![
                finding("ollama", "unreachable"),
                finding("omlx", "unreachable"),
            ],
            absent(),
            gate::DEFAULT_LOCAL_MODEL.to_string(),
        );
        let v: Value = serde_json::from_str(&render_json(&r)).unwrap();
        assert_eq!(v["kind"], SETUP_KIND);
        assert_eq!(v["schema_version"], 1);
        assert_eq!(v["tool"], "ashlr-md");
        assert_eq!(v["downloads"], false);
        assert_eq!(v["writes"], false);
        assert_eq!(v["servers"][0]["provider"], "ollama");
        assert_eq!(v["servers"][0]["baseUrl"], "http://127.0.0.1:11434/v1");
        assert_eq!(v["servers"][0]["probe"]["status"], "unreachable");
        assert_eq!(v["servers"][1]["provider"], "omlx");
        assert_eq!(v["config"]["status"], "absent");
        assert_eq!(v["recommended"]["pullCommand"], "ollama pull qwen3.8:27b");
        assert_eq!(v["config_snippet"]["localInference"]["offline"], true);
        assert_eq!(v["next"].as_array().unwrap().len(), 3);
        assert_eq!(v["next"][0]["command"], "ollama pull qwen3.8:27b");
    }

    #[test]
    fn setup_arguments() {
        let (out, err, code) = setup(&[]);
        assert_eq!((code, err.as_str()), (0, ""));
        assert_eq!(out, SETUP_HELP);
        let (out, _, code) = setup(&["--help".into()]);
        assert_eq!((code, out.as_str()), (0, SETUP_HELP));
        let (out, err, code) = setup(&["--local".into(), "--apply".into()]);
        assert_eq!(code, 2);
        assert!(out.is_empty());
        assert!(
            err.starts_with("mdopener-mcp setup: unknown argument `--apply`\n"),
            "{err}"
        );
        assert!(
            err.contains("downloads nothing and writes nothing"),
            "{err}"
        );
    }
}
