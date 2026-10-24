//! The GFM task checkboxes of a Markdown text (`- [ ]` / `- [x]`, with `*`
//! and `+` bullets and ordered items too): what the app's `/annotations`
//! endpoint and the `get_user_annotations` MCP tool (which includes this
//! file, and reads the file on disk when the app is not running) report as
//! `tasks`. Shared so the two cannot disagree on what a task is.

/// For each line of `content`, as [`crate::markdown_lines::markdown_lines`]
/// yields them, whether its checkbox is checked and the text after it
/// (trimmed) when the line holds a GFM task checkbox, as the renderer
/// (remark-gfm) reads one: `[ ]`, `[x]` or `[X]` at the start of a list
/// item's first content, by the container rule fences follow
/// ([`crate::markdown_lines::item_starts`]), so `> - [ ] t` and `1. [ ] t`
/// are tasks and `    - [ ] t` (indented code) is not. The checkbox is
/// followed by a space or a tab and more text, or ends a line the
/// paragraph goes on after (`- [ ]`, then `  more`); `- [ ]` alone is text.
pub fn task_marks(content: &str) -> Vec<Option<(bool, String)>> {
    let lines: Vec<_> = crate::markdown_lines::item_starts(content).collect();
    (0..lines.len())
        .map(|i| {
            let text = lines[i].text.as_deref()?;
            let checked = match text.get(..3)? {
                "[ ]" => false,
                "[x]" | "[X]" => true,
                _ => return None,
            };
            let rest = &text[3..];
            let more = rest.trim();
            // The line after the paragraph the checkbox starts.
            let end = (i + 1..lines.len())
                .find(|&j| !lines[j].continues)
                .unwrap_or(lines.len());
            let task = if lines.get(end).is_some_and(|l| l.underline) {
                // A setext heading, not a paragraph, holds it.
                false
            } else if more.is_empty() {
                // Nothing after it on the line: a task only when the
                // paragraph goes on.
                end > i + 1
            } else {
                rest.starts_with([' ', '\t'])
            };
            task.then(|| (checked, more.to_string()))
        })
        .collect()
}

/// Each task line of `content`, in order, as `{ text, checked }`, by the
/// rule of [`task_marks`]. A line of a leading YAML front matter block, of
/// fenced code or of indented code is not a task: a `- [ ] step` in a code
/// sample used to be reported as one of the document's tasks. Tasks used to
/// be read from raw lines, so a task in a blockquote or an ordered item was
/// missed and an indented `- [ ] t` (code) was one.
pub fn parse_tasks(content: &str) -> Vec<serde_json::Value> {
    task_marks(content)
        .into_iter()
        .flatten()
        .map(|(checked, text)| serde_json::json!({ "text": text, "checked": checked }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::task_marks;

    /// The 1-based lines that hold a task, with whether each is checked.
    fn tasks(content: &str) -> Vec<(usize, bool, String)> {
        task_marks(content)
            .into_iter()
            .enumerate()
            .filter_map(|(i, m)| m.map(|(checked, text)| (i + 1, checked, text)))
            .collect()
    }

    fn t(line: usize, checked: bool, text: &str) -> (usize, bool, String) {
        (line, checked, text.to_string())
    }

    /// Tasks were read from raw lines: a quoted task and an ordered one were
    /// missed, and an indented `- [ ] t` (indented code) was a task.
    #[test]
    fn tasks_follow_the_container_rule_of_the_renderer() {
        assert_eq!(tasks("> - [ ] quoted\n"), vec![t(1, false, "quoted")]);
        assert_eq!(
            tasks("1. [x] first\n2) [ ] second\n"),
            vec![t(1, true, "first"), t(2, false, "second")]
        );
        assert_eq!(tasks("1) [X] one\n"), vec![t(1, true, "one")]);
        assert_eq!(tasks("> 1. - [ ] deep\n"), vec![t(1, false, "deep")]);
        assert!(tasks("    - [ ] code\n").is_empty());
        assert!(tasks("a\n\n    - [ ] code\n").is_empty());
        assert!(tasks("-     [ ] code\n").is_empty());
        // A blockquote in an item is not the item's first content.
        assert!(tasks("- > [ ] quote\n").is_empty());
        // `2)` cannot interrupt a paragraph, so it is text.
        assert!(tasks("para\n2) [ ] t\n").is_empty());
        // Nested items and an item's continuation line.
        assert_eq!(
            tasks("- [ ] a\n  - [x] b\n  [ ] not\n"),
            vec![t(1, false, "a"), t(2, true, "b")]
        );
    }

    /// The checkbox needs a space or a tab and more text after it, or a
    /// paragraph that goes on, as remark-gfm reads it.
    #[test]
    fn a_checkbox_needs_text_after_it() {
        assert!(tasks("- [x]\n").is_empty());
        assert!(tasks("- [ ]   \n").is_empty());
        assert!(tasks("- [ ]x\n").is_empty());
        assert_eq!(tasks("- [ ]\ttab\n"), vec![t(1, false, "tab")]);
        assert_eq!(tasks("- [x]\n  more\n"), vec![t(1, true, "")]);
        assert_eq!(tasks("- [ ]\nlazy\n"), vec![t(1, false, "")]);
        // A line that interrupts the paragraph does not make it go on.
        assert!(tasks("- [ ]\n  - b\n").is_empty());
        assert!(tasks("- [ ]\n# h\n").is_empty());
        assert!(tasks("- [ ]\n- - -\n").is_empty());
        // A setext underline makes the paragraph a heading.
        assert!(tasks("- [ ]\n  ---\n").is_empty());
        assert!(tasks("- [x] a\n  ===\n").is_empty());
    }

    /// micromark reads a tab inside the brackets as the checkbox's space only
    /// where the tab is one column wide (it ends at a multiple of four), and
    /// a wider tab leaves its other columns as spaces, which is not a
    /// checkbox. The tab-expanded text gives the same answer, at every column
    /// and behind blockquote and list markers (checked against remark-gfm on
    /// generated documents), so it is not missed where remark-gfm sees one.
    #[test]
    fn a_tab_inside_the_brackets_counts_where_it_is_one_column_wide() {
        assert_eq!(tasks("- [\t] t\n"), vec![t(1, false, "t")]);
        assert_eq!(tasks("1000. [\t] t\n"), vec![t(1, false, "t")]);
        assert_eq!(tasks(">\t- [\t] t\n"), vec![t(1, false, "t")]);
        assert_eq!(tasks("-\n  [\t]\tt\n"), vec![t(2, false, "t")]);
        assert!(tasks("-  [\t] t\n").is_empty());
        assert!(tasks("1. [\t] t\n").is_empty());
        assert!(tasks("> - [\t] t\n").is_empty());
        assert!(tasks("10. [\t] t\n").is_empty());
    }

    /// The first content of an item opened by a bare marker is on the next
    /// line, at the item's content column; a space after the marker, or
    /// more indentation, leaves the item without one.
    #[test]
    fn a_bare_item_has_its_checkbox_on_the_next_line() {
        assert_eq!(tasks("-\n  [ ] t\n"), vec![t(2, false, "t")]);
        assert_eq!(tasks("> 1.\n>    [x] t\n"), vec![t(2, true, "t")]);
        assert!(tasks("- \n  [ ] t\n").is_empty());
        assert!(tasks("-\n    [ ] t\n").is_empty());
        assert!(tasks("-\n\n  [ ] t\n").is_empty());
    }
}
