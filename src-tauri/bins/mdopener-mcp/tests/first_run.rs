//! A fresh user's complete read-only stdio journey: no desktop app, saved
//! configuration, model server, or access to the user's real home directory.
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

struct Client {
    child: Child,
    replies: Receiver<Value>,
    next_id: u64,
}

impl Client {
    fn new(home: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
            .env("HOME", home)
            .env("USERPROFILE", home)
            .current_dir(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let reply = serde_json::from_str(&line.unwrap()).expect("JSON-RPC stdout");
                if tx.send(reply).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            replies,
            next_id: 0,
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let request = json!({"jsonrpc":"2.0", "id":self.next_id, "method":method, "params":params});
        writeln!(self.child.stdin.as_mut().unwrap(), "{request}").unwrap();
        let reply = self
            .replies
            .recv_timeout(Duration::from_secs(10))
            .expect(method);
        assert_eq!(reply["jsonrpc"], "2.0");
        assert_eq!(reply["id"], self.next_id, "{reply}");
        assert!(reply.get("error").is_none(), "{reply}");
        reply["result"].clone()
    }

    fn call(&mut self, name: &str, arguments: Value, error: bool) -> Value {
        let result = self.request("tools/call", json!({"name":name, "arguments":arguments}));
        assert_eq!(result["isError"], error, "{name}: {result}");
        let text = result["content"][0]["text"].as_str().expect(name);
        assert!(!text.trim().is_empty(), "{name}");
        if error {
            json!(text)
        } else {
            serde_json::from_str(text).expect(name)
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        // Also reap the server if an assertion fails or a response times out.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn fresh_home_discovers_and_calls_every_read_only_tool() {
    // A non-hidden vault inside HOME: tempfile's default directory name is hidden.
    let home = tempfile::tempdir().unwrap();
    let vault = home.path().join("vault");
    std::fs::create_dir(&vault).unwrap();
    let path = vault.join("welcome.md");
    let revised = vault.join("revised.md");
    let markdown = "---\ntitle: First run\n---\n# Welcome\n\nHello **agent** café.\n\n- [ ] Review [[Plan#Goals]]\n- [x] Read the guide\n";
    std::fs::write(&path, markdown).unwrap();
    std::fs::write(&revised, markdown.replace("Hello", "Goodbye")).unwrap();
    let mut client = Client::new(home.path());
    let init = client.request(
        "initialize",
        json!({
            "protocolVersion":"2025-06-18", "capabilities":{},
            "clientInfo":{"name":"first-run", "version":"1"}
        }),
    );
    assert_eq!(init["protocolVersion"], "2025-06-18");
    assert_eq!(init["serverInfo"]["name"], "mdopener-mcp");
    assert!(init["capabilities"]["tools"].is_object());
    writeln!(
        client.child.stdin.as_mut().unwrap(),
        "{}",
        json!({"jsonrpc":"2.0", "method":"notifications/initialized"})
    )
    .unwrap();
    let catalog = client.request("tools/list", json!({}));
    let tools = catalog["tools"].as_array().unwrap();
    let discovered: BTreeSet<_> = tools
        .iter()
        .filter(|t| t["annotations"]["readOnlyHint"] == true)
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    let covered = BTreeSet::from([
        "get_current_content",
        "list_recent",
        "get_user_annotations",
        "search_vault",
        "list_ai_actions",
        "get_conversation_context",
        "diff_documents",
        "export_text",
        "export_metadata",
    ]);
    assert_eq!(
        discovered, covered,
        "add a first-run call for each new read tool"
    );
    for tool in tools {
        assert!(!tool["description"].as_str().unwrap().trim().is_empty());
        assert_eq!(tool["inputSchema"]["type"], "object");
    }
    for name in ["get_current_content", "list_recent"] {
        let error = client.call(name, json!({}), true);
        assert!(error.as_str().unwrap().contains("open_file"));
        assert!(
            error
                .as_str()
                .unwrap()
                .contains("does not appear to be running"),
            "{error}"
        );
    }
    let text = client.call("export_text", json!({"path":path}), false);
    assert!(text["text"].as_str().unwrap().contains("Hello agent café."));
    assert_eq!(text["path"], path.canonicalize().unwrap().to_str().unwrap());
    assert_eq!(
        text["char_count"],
        text["text"].as_str().unwrap().chars().count()
    );
    assert!(text["word_count"].as_u64().unwrap() > 0);
    let metadata = client.call("export_metadata", json!({"path":path}), false);
    assert_eq!(metadata["frontmatter"]["title"], "First run");
    assert_eq!(metadata["headings"], json!([{"level":1,"text":"Welcome"}]));
    assert_eq!(metadata["wikilinks"], json!(["Plan"]));
    let annotations = client.call("get_user_annotations", json!({"path":path}), false);
    assert_eq!(annotations["appRunning"], false);
    assert_eq!(annotations["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(annotations["tasks"][0]["checked"], false);
    assert_eq!(annotations["tasks"][1]["checked"], true);
    assert!(annotations["verdict"].is_null());
    let search = client.call(
        "search_vault",
        json!({"vault":vault, "query":"café", "semantic":false}),
        false,
    );
    assert_eq!(search["mode"], "grep-disk");
    assert_eq!(search["results"].as_array().unwrap().len(), 2);
    let actions = client.call("list_ai_actions", json!({}), false);
    assert!(actions["count"].as_u64().unwrap() > 0);
    assert!(actions["actions"][0]["systemPrompt"].is_string());
    let context = client.call(
        "get_conversation_context",
        json!({"session_id":"first-run"}),
        false,
    );
    assert_eq!(context["count"], 0);
    assert_eq!(context["messages"], json!([]));
    let diff = client.call(
        "diff_documents",
        json!({"path_a":path,"path_b":revised}),
        false,
    );
    assert_eq!(diff["added"], 1);
    assert_eq!(diff["removed"], 1);
    assert!(diff["diff"].as_str().unwrap().contains("+Goodbye"));
    // Reading and discovering must leave the source documents unchanged.
    assert_eq!(std::fs::read_to_string(&path).unwrap(), markdown);
    assert_eq!(
        std::fs::read_to_string(&revised).unwrap(),
        markdown.replace("Hello", "Goodbye")
    );
    drop(client.child.stdin.take());
    assert!(client.child.wait().unwrap().success());
}
