//! End-to-end agent journey against the real `mdopener-mcp` binary over
//! stdio, one request and one reply at a time the way an MCP client drives
//! it: initialize, tools/list, then the tools that work from disk alone on a
//! temp vault (read, outline and diff documents, keep conversation memory)
//! and the ones that need the app, which must fail as `isError` results.
//! HOME points at a temp dir, so the sessions dir is `<tmp>/.mdopener/sessions`
//! and no real `~/.mdopener` is read or written; no app is running.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// One running server and the client side of its stdio.
struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Client {
    /// Start the server with `home` as HOME and `cwd` as its working dir.
    fn start(home: &Path, cwd: &Path) -> Client {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
            .env("HOME", home)
            .env("USERPROFILE", home)
            .env_remove("XDG_CONFIG_HOME")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Client {
            child,
            stdin,
            stdout,
            next_id: 1,
        }
    }

    fn send(&mut self, message: &Value) {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Send a request and wait for its reply, which must carry its id.
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let mut line = String::new();
        assert!(
            self.stdout.read_line(&mut line).unwrap() > 0,
            "{method}: EOF"
        );
        let reply: Value = serde_json::from_str(&line).expect("stdout must be JSON-RPC only");
        assert_eq!(reply["id"], id, "{method}: {reply}");
        reply
    }

    /// Call a tool; returns `(isError, text)` of its single text content.
    fn call(&mut self, tool: &str, arguments: Value) -> (bool, String) {
        let reply = self.request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        );
        assert!(reply.get("error").is_none(), "{tool}: {reply}");
        let result = &reply["result"];
        let text = result["content"][0]["text"].as_str();
        let text = text.unwrap_or_else(|| panic!("{tool}: no text: {reply}"));
        (result["isError"] == true, text.to_string())
    }

    /// Call a tool that must succeed; returns its JSON result.
    fn ok(&mut self, tool: &str, arguments: Value) -> Value {
        let (is_error, text) = self.call(tool, arguments);
        assert!(!is_error, "{tool} failed: {text}");
        serde_json::from_str(&text).unwrap_or_else(|_| panic!("{tool}: not JSON: {text}"))
    }

    /// Close stdin and require a clean exit.
    fn finish(mut self) {
        drop(self.stdin);
        let mut rest = String::new();
        std::io::Read::read_to_string(&mut self.stdout, &mut rest).unwrap();
        assert!(rest.is_empty(), "unexpected output: {rest}");
        assert!(self.child.wait().unwrap().success());
    }
}

const PLAN: &str = "---
title: Launch plan
tags: [launch, q4]
aliases:
  - Plan
  - Launch
owner:
  name: Zoë
---
# Launch plan

Ship the **beta** to [early users](https://example.com) by Friday.
See [[Roadmap]] and [[Risks|the risks]].

![diagram](assets/flow.png)

## Steps

- [ ] Write the changelog
- [x] Freeze the API

```sh
cargo build --release
```

## Owner ##

Ünïcode owner: Zoë.
";

/// A temp vault: `plan.md`, its revision, a non-Markdown file and a dotfile.
fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let v = dir.path();
    std::fs::write(v.join("plan.md"), PLAN).unwrap();
    std::fs::write(
        v.join("plan v2.md"),
        PLAN.replace("by Friday", "by Monday")
            .replace("- [ ] Write", "- [x] Write"),
    )
    .unwrap();
    std::fs::write(v.join("secrets.txt"), "token=abc").unwrap();
    std::fs::write(v.join(".hidden.md"), "# hidden").unwrap();
    dir
}

#[test]
fn an_agent_works_a_vault_from_disk_without_the_app() {
    let home = tempfile::tempdir().unwrap();
    let vault = vault();
    let v = vault.path().canonicalize().unwrap();
    let plan = v.join("plan.md");
    let plan = plan.to_str().unwrap();

    let mut c = Client::start(home.path(), &v);

    // ── Handshake ──────────────────────────────────────────────────────────
    let init = c.request(
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "agent-journey", "version": "1" }
        }),
    );
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert!(
        init["result"]["capabilities"]["tools"].is_object(),
        "{init}"
    );
    c.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));

    let list = c.request("tools/list", json!({}));
    let tools = list["result"]["tools"].as_array().unwrap();
    for name in [
        "export_text",
        "export_metadata",
        "diff_documents",
        "search_vault",
        "save_conversation_message",
        "get_conversation_context",
    ] {
        let tool = tools.iter().find(|t| t["name"] == name);
        let tool = tool.unwrap_or_else(|| panic!("{name} not listed"));
        assert_eq!(tool["inputSchema"]["type"], "object", "{name}");
    }

    // ── Read the document ──────────────────────────────────────────────────
    // A path relative to the server's working directory, as an agent in the
    // project directory would pass it.
    let text = c.ok("export_text", json!({ "path": "plan.md" }));
    let body = text["text"].as_str().unwrap();
    assert!(
        body.contains("Ship the beta to early users by Friday."),
        "{body}"
    );
    assert!(
        body.contains("cargo build --release"),
        "code is kept: {body}"
    );
    assert!(body.contains("Zoë"), "{body}");
    assert!(!body.contains("**") && !body.contains("](http"), "{body}");
    assert!(!body.contains("title: Launch plan"), "front matter: {body}");
    assert!(!body.contains("Owner ##"), "closing hashes: {body}");
    assert!(text["word_count"].as_u64().unwrap() > 10, "{text}");
    assert_eq!(text["path"], plan, "{text}");

    let meta = c.ok("export_metadata", json!({ "path": plan }));
    assert_eq!(meta["frontmatter"]["title"], "Launch plan", "{meta}");
    assert_eq!(
        meta["frontmatter"]["tags"],
        json!(["launch", "q4"]),
        "{meta}"
    );
    assert_eq!(
        meta["frontmatter"]["aliases"],
        json!(["Plan", "Launch"]),
        "{meta}"
    );
    assert!(
        meta["frontmatter"].get("name").is_none(),
        "nested key leaked: {meta}"
    );
    let headings: Vec<(u64, &str)> = meta["headings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (h["level"].as_u64().unwrap(), h["text"].as_str().unwrap()))
        .collect();
    assert_eq!(
        headings,
        [(1, "Launch plan"), (2, "Steps"), (2, "Owner")],
        "a `#` inside the code block is not a heading: {meta}"
    );
    let links = meta["wikilinks"].to_string();
    assert!(
        links.contains("Roadmap") && links.contains("Risks"),
        "{meta}"
    );
    assert_eq!(meta["embedded_image_count"], 1, "{meta}");
    assert_eq!(meta["path"], plan, "{meta}");

    // ── Compare two revisions ──────────────────────────────────────────────
    let diff = c.ok(
        "diff_documents",
        json!({ "path_a": plan, "path_b": v.join("plan v2.md") }),
    );
    assert_eq!(diff["added"], 2, "{diff}");
    assert_eq!(diff["removed"], 2, "{diff}");
    let d = diff["diff"].as_str().unwrap();
    assert!(d.contains("-Ship the **beta** to [early users](https://example.com) by Friday."));
    assert!(d.contains("+- [x] Write the changelog"), "{d}");

    // ── Refusals the agent must see ────────────────────────────────────────
    for (path, why) in [
        ("secrets.txt", "not Markdown"),
        (".hidden.md", "a dotfile"),
        ("missing.md", "missing"),
    ] {
        for tool in ["export_text", "export_metadata"] {
            let (is_error, msg) = c.call(tool, json!({ "path": path }));
            assert!(is_error, "{tool} {path} ({why}): {msg}");
            assert!(!msg.contains("token=abc"), "{tool} leaked {path}: {msg}");
        }
    }

    // Search needs the app's vault list: with no app and no `vault` it is an
    // error result that names the app and the way out, never an empty
    // "nothing found".
    let (is_error, msg) = c.call("search_vault", json!({ "query": "changelog" }));
    assert!(is_error, "search_vault without the app: {msg}");
    assert!(msg.contains("Ashlr MD"), "{msg}");
    assert!(msg.contains("`vault`"), "names the argument to pass: {msg}");

    // ── Search the vault on disk ───────────────────────────────────────────
    // Naming the vault directory greps its Markdown files instead, and the
    // note says so. Dotfiles, non-Markdown files and hidden dirs are skipped.
    std::fs::create_dir(v.join("notes")).unwrap();
    std::fs::write(v.join("notes/later.md"), "Write the CHANGELOG later.\n").unwrap();
    std::fs::create_dir(v.join(".git")).unwrap();
    std::fs::write(v.join(".git/changelog.md"), "changelog").unwrap();
    std::fs::write(v.join("changelog.txt"), "changelog").unwrap();
    std::fs::write(v.join(".changelog.md"), "changelog").unwrap();
    for vault_arg in [".", v.to_str().unwrap()] {
        let found = c.ok(
            "search_vault",
            json!({ "query": "changelog", "semantic": false, "vault": vault_arg }),
        );
        assert_eq!(found["mode"], "grep-disk", "{found}");
        assert_eq!(found["vault"], v.to_str().unwrap(), "{found}");
        let note = found["note"].as_str().unwrap_or_default();
        assert!(note.contains("on disk"), "{found}");
        let mut paths: Vec<&str> = found["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["path"].as_str().unwrap())
            .collect();
        paths.sort();
        let (v2, later) = (v.join("plan v2.md"), v.join("notes/later.md"));
        let mut want = vec![plan, v2.to_str().unwrap(), later.to_str().unwrap()];
        want.sort();
        assert_eq!(paths, want, "{found}");
        let first = &found["results"][0];
        assert!(first["lineNumber"].as_u64().unwrap() > 0, "{found}");
        assert!(first["snippet"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("changelog"));
    }
    let limited = c.ok(
        "search_vault",
        json!({ "query": "changelog", "semantic": false, "vault": ".", "limit": 1 }),
    );
    assert_eq!(limited["results"].as_array().unwrap().len(), 1, "{limited}");
    // The resource takes the same `vault` (it is semantic when Ollama runs).
    let read = c.request(
        "resources/read",
        json!({ "uri": "text://vault-search?q=CHANGELOG+later&vault=notes" }),
    );
    let payload: Value =
        serde_json::from_str(read["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    if !mdopener_mcp::ollama_available() {
        assert_eq!(payload["mode"], "grep-disk", "{read}");
        assert_eq!(payload["results"].as_array().unwrap().len(), 1, "{read}");
    }
    assert!(
        payload["note"].as_str().unwrap().contains("on disk"),
        "{read}"
    );
    // A vault that is not a directory is refused.
    for bad in ["plan.md", "missing-dir"] {
        let (is_error, msg) = c.call("search_vault", json!({ "query": "x", "vault": bad }));
        assert!(is_error, "vault {bad}: {msg}");
        assert!(msg.contains("`vault`"), "{msg}");
    }
    // So is reading the open document when there is no app to ask.
    let (is_error, msg) = c.call("export_text", json!({}));
    assert!(is_error, "export_text without a path or app: {msg}");

    // ── Conversation memory ────────────────────────────────────────────────
    let session = "launch-review.1";
    let saved = c.ok(
        "save_conversation_message",
        json!({
            "session_id": session,
            "role": "agent",
            "content": "Moved the beta date to Monday.",
            "cited_docs": [plan],
        }),
    );
    assert_eq!(saved["ok"], true, "{saved}");
    assert_eq!(saved["sessionId"], session, "{saved}");
    c.ok(
        "save_conversation_message",
        json!({ "session_id": session, "role": "human", "content": "Approved — ship it." }),
    );
    // Bad arguments are a JSON-RPC invalid-params error, as for every tool.
    let bad = c.request(
        "tools/call",
        json!({ "name": "save_conversation_message",
                "arguments": { "session_id": session, "role": "robot", "content": "x" } }),
    );
    assert_eq!(
        bad["error"]["code"], -32602,
        "an unknown role is refused: {bad}"
    );

    let ctx = c.ok("get_conversation_context", json!({ "session_id": session }));
    assert_eq!(ctx["count"], 2, "{ctx}");
    assert_eq!(ctx["messages"][0]["role"], "agent", "{ctx}");
    assert_eq!(
        ctx["messages"][1]["content"], "Approved — ship it.",
        "{ctx}"
    );
    assert_eq!(ctx["recentDocs"], json!([plan]), "{ctx}");
    let other = c.ok(
        "get_conversation_context",
        json!({ "session_id": "launch-review_1" }),
    );
    assert_eq!(
        other["count"], 0,
        "ids that differ do not share history: {other}"
    );

    // Saved under the temp HOME, in the file name the app also uses.
    let file = home
        .path()
        .join(".mdopener/sessions/launch-review%2E1.json");
    let on_disk = std::fs::read_to_string(&file).unwrap();
    assert!(on_disk.contains("Moved the beta date"), "{on_disk}");

    c.finish();

    // A later agent process picks the session up where this one left it.
    let mut c = Client::start(home.path(), &v);
    c.request(
        "initialize",
        json!({ "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "agent-journey", "version": "1" } }),
    );
    let ctx = c.ok(
        "get_conversation_context",
        json!({ "session_id": session, "limit": 1 }),
    );
    assert_eq!(ctx["count"], 1, "{ctx}");
    assert_eq!(ctx["messages"][0]["role"], "human", "the latest one: {ctx}");
    c.finish();
}
