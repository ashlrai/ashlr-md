//! Snapshots captured before the payload audit. They protect the JSON fields
//! and values consumed by clients while allowing descriptions to be shortened.
use mdopener_mcp::{doctor_fix, local_inference_probe::ProbeResult, offline};
use serde_json::{json, Value};

fn without_descriptions(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("description");
            for child in map.values_mut() {
                without_descriptions(child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(without_descriptions),
        _ => {}
    }
}

#[test]
fn tools_list_preserves_schemas_annotations_and_order() {
    let expected: Value =
        serde_json::from_str(include_str!("contract/tools-list-fields.v1.json")).unwrap();
    let mut actual = mdopener_mcp::tool_list();
    without_descriptions(&mut actual);
    assert_eq!(actual, expected);
    let response = json!({"jsonrpc":"2.0", "id":2, "result":{"tools":mdopener_mcp::tool_list()}});
    assert!(
        response.to_string().len() < 38_440,
        "tools/list exceeded its pre-audit size"
    );
}

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn assert_compact_snapshot(output: &str, expected: Value) {
    let actual: Value = serde_json::from_str(output).unwrap();
    assert_eq!(actual, expected);
    assert_eq!(output, format!("{}\n", actual));
}

#[test]
fn doctor_json_preserves_the_full_consumer_snapshot() {
    let expected = fixture(include_str!("contract/doctor.v1.json"));
    let mut base = expected.clone();
    base["checks"].as_array_mut().unwrap().pop();
    let out = offline::doctor_with(true, &base.to_string(), false).unwrap();
    assert_compact_snapshot(&out, expected);
}

#[test]
fn doctor_fix_json_preserves_the_full_consumer_snapshot() {
    let home = tempfile::tempdir().unwrap();
    let (out, err, code) = doctor_fix::run(
        &["--fix".into(), "--json".into()],
        Some(&home.path().join(".mdopener")),
    );
    assert_eq!((err.as_str(), code), ("", 0));
    assert_compact_snapshot(&out, fixture(include_str!("contract/doctor-fix.v1.json")));
}

#[test]
fn setup_json_preserves_the_full_consumer_snapshot() {
    let finding = |provider: &str, reachable: bool| offline::ServerFinding {
        provider: provider.into(),
        base_url: format!(
            "http://127.0.0.1:{}/v1",
            if reachable { 11434 } else { 8000 }
        ),
        probe: ProbeResult {
            status: if reachable {
                "reachable"
            } else {
                "unreachable"
            },
            provider: Some(provider.into()),
            loopback: true,
            reachable,
            http_status: reachable.then_some(200),
            model_count: if reachable { 4 } else { 0 },
            reason: (!reachable).then(|| "connect-failed".into()),
            bytes_read: 0,
        },
    };
    let report = offline::build(
        vec![finding("ollama", true), finding("omlx", false)],
        offline::ConfigFinding {
            status: "absent",
            offline: false,
            provider: None,
            probe: None,
        },
        "qwen3.8:27b".into(),
    );
    assert_compact_snapshot(
        &offline::render_json(&report),
        fixture(include_str!("contract/setup-local.v1.json")),
    );
}

#[test]
fn ai_actions_response_preserves_the_consumer_snapshot() {
    let expected = fixture(include_str!("contract/list-ai-actions.v1.json"));
    let actual = mdopener_mcp::tool_list_ai_actions(json!(3), &json!({"include_prompts":false}));
    assert_eq!(serde_json::to_value(actual).unwrap(), expected);
}
