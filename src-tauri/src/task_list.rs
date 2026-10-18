//! The GFM task checkboxes of a Markdown text (`- [ ]` / `- [x]`, with `*`
//! and `+` bullets too): what the app's `/annotations` endpoint and the
//! `get_user_annotations` MCP tool (which includes this file, and reads the
//! file on disk when the app is not running) report as `tasks`. Shared so
//! the two cannot disagree on what a task is.

/// Each task line of `content`, in order, as `{ text, checked }`. A line
/// of a leading YAML front matter block or of fenced code is not a task
/// ([`crate::markdown_lines`]): a `- [ ] step` in a code sample used to be
/// reported as one of the document's tasks.
pub fn parse_tasks(content: &str) -> Vec<serde_json::Value> {
    crate::markdown_lines::text_lines(content)
        .filter_map(|line| {
            let t = line.trim_start();
            let rest = t
                .strip_prefix("- ")
                .or_else(|| t.strip_prefix("* "))
                .or_else(|| t.strip_prefix("+ "))?
                .trim_start();
            let checked = if rest.starts_with("[ ]") {
                false
            } else if rest.starts_with("[x]") || rest.starts_with("[X]") {
                true
            } else {
                return None;
            };
            let text = rest[3..].trim().to_string();
            Some(serde_json::json!({ "text": text, "checked": checked }))
        })
        .collect()
}
