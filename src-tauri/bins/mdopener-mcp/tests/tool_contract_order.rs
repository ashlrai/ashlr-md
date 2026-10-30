//! Pin presentation order separately from the alphabetically sorted contract.
use mdopener_mcp::{tool_list, tool_registry, ToolTier, ALL_TOOL_NAMES};

const REVIEWED_ORDER: &[&str] = &[
    "open_file",
    "get_current_content",
    "list_recent",
    "request_review",
    "get_user_annotations",
    "edit_document",
    "search_vault",
    "present_document",
    "list_ai_actions",
    "get_conversation_context",
    "save_conversation_message",
    "diff_documents",
    "stream_edit",
    "stream_edit_apply",
    "export_text",
    "export_metadata",
    "edit_canvas",
    "export",
    "replace_document",
    "set_content",
];

#[test]
fn registry_and_tool_list_keep_reviewed_order() {
    let registry = tool_registry();
    let names: Vec<_> = registry.iter().map(|tool| tool.name).collect();
    assert_eq!(names, REVIEWED_ORDER);
    assert_eq!(ALL_TOOL_NAMES, REVIEWED_ORDER);

    let listed = tool_list();
    let listed_names: Vec<_> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(listed_names, REVIEWED_ORDER);
}

#[test]
fn destructive_tools_follow_all_read_only_and_targeted_tools() {
    let registry = tool_registry();
    let first_destructive = registry
        .iter()
        .position(|tool| tool.tier == ToolTier::Destructive)
        .expect("registry contains destructive tools");
    assert!(first_destructive > 0);
    assert!(registry[first_destructive..]
        .iter()
        .all(|tool| tool.tier == ToolTier::Destructive));
}
