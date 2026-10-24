//! The lines of a Markdown text, each with what it is: part of a leading
//! YAML front matter block, a code fence, a line of fenced code, or text.
//! The app and mdopener-mcp (which includes this file) share it, so every
//! scanner that must not read code as Markdown (a document's title, the
//! headings, wikilinks and image count of `export_metadata`, the plain text
//! of `export_text`, the task checkboxes of `/annotations` and
//! `get_user_annotations`) uses one rule for front matter and one for fences.
//! [`atx_heading`] is the one ATX heading rule of a document's title and of
//! `export_metadata`'s headings.
//! Those scanners used to flip an "in code" flag on any line starting with
//! ```` ``` ```` or `~~~`, so a ```` ```` ```` block holding ```` ``` ````
//! ended early and a `~~~` line closed a backtick block.

/// What a line of a Markdown text is, from [`markdown_lines`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineKind {
    /// A line of a leading front matter block, its opening `---` and its
    /// closing `---` or `...` included.
    FrontMatter,
    /// A code fence: the line that opens a fenced code block or closes it.
    Fence,
    /// A line inside a fenced code block.
    Code,
    /// A line of an indented code block, only from [`with_indented_code`].
    IndentedCode,
    /// Any other line.
    Text,
}

/// Each line of `content` (as [`str::lines`] splits it) with its
/// [`LineKind`]. Front matter is a first line of `---` closed by a later
/// `---` or `...` line; a `---` never closed is a thematic break, not front
/// matter. A fence is at most three spaces, then three or more backticks or
/// tildes (a backtick fence's info string has no backtick). It is closed by
/// a fence of the same character at least as long with nothing after it,
/// and a fence left open runs to the end, as in CommonMark.
pub fn markdown_lines(content: &str) -> impl Iterator<Item = (LineKind, &str)> {
    let front_matter = front_matter_len(content);
    let mut fence: Option<(char, usize)> = None;
    content.lines().enumerate().map(move |(i, line)| {
        if i < front_matter {
            return (LineKind::FrontMatter, line);
        }
        let kind = match (fence, code_fence(line)) {
            (Some((c, n)), Some((rc, rn, rest)))
                if rc == c && rn >= n && rest.trim().is_empty() =>
            {
                fence = None;
                LineKind::Fence
            }
            (Some(_), _) => LineKind::Code,
            (None, Some((rc, rn, _))) => {
                fence = Some((rc, rn));
                LineKind::Fence
            }
            (None, None) => LineKind::Text,
        };
        (kind, line)
    })
}

/// The lines of `content` that are Markdown text: not front matter, not a
/// fence and not fenced code.
pub fn text_lines(content: &str) -> impl Iterator<Item = &str> {
    markdown_lines(content)
        .filter(|(kind, _)| *kind == LineKind::Text)
        .map(|(_, line)| line)
}

/// How many lines a leading front matter block takes, its two delimiters
/// included; 0 when there is none.
pub fn front_matter_len(content: &str) -> usize {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return 0;
    }
    lines
        .position(|l| matches!(l.trim(), "---" | "..."))
        .map_or(0, |i| i + 2)
}

/// The fence character, its run length and the rest of the line when `line`
/// is a code fence: at most three spaces, then three or more backticks or
/// tildes (a backtick fence's info string has no backtick).
fn code_fence(line: &str) -> Option<(char, usize, &str)> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let c = body.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let n = body.chars().take_while(|&x| x == c).count();
    let rest = &body[n..];
    (n >= 3 && !(c == '`' && rest.contains('`'))).then_some((c, n, rest))
}

/// The level and text of `line` when it is an ATX heading, as CommonMark
/// reads one: at most three spaces of indentation, 1 to 6 `#`s, then a
/// space, a tab or the end of the line. The text is trimmed and loses an
/// optional closing run of `#`s that follows a space or a tab (`Title ##`
/// is `Title`, `C#` keeps its `#`, and `#` alone or `## ##` is an empty
/// heading). A line indented four spaces or a tab is indented code, not a
/// heading, and `#tag` or `#!/bin/sh` is text.
// mdopener-mcp uses it; the app includes this file only for its tasks.
#[allow(dead_code)]
pub fn atx_heading(line: &str) -> Option<(usize, &str)> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let level = body.bytes().take_while(|&b| b == b'#').count();
    let rest = &body[level..];
    if !(1..=6).contains(&level) || !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    let text = rest.trim_matches([' ', '\t']);
    let open = text.trim_end_matches('#');
    let text = if open.len() == text.len() {
        text
    } else if open.is_empty() {
        ""
    } else if open.ends_with([' ', '\t']) {
        open.trim_end_matches([' ', '\t'])
    } else {
        text
    };
    Some((level, text))
}

/// [`markdown_lines`], with the text lines of an indented code block marked
/// [`LineKind::IndentedCode`]: a line indented four columns or more (a tab
/// reaches the next multiple of four) that opens a block after a blank
/// line, a heading, a fence or the start of the document, and the indented
/// lines after it, blank lines between them included. An indented line in
/// a paragraph continues the paragraph, as CommonMark reads it.
///
/// Inside a list an indented line is often an item's continuation, not
/// code, and telling the two apart needs the item's content column. So
/// after a list item no indented line is code until the list ends at a line
/// that starts at column 0, is not a list item and follows a blank line (or
/// is a heading). That reads some code inside a list item as text, never
/// text as code.
#[allow(dead_code)]
pub fn with_indented_code(content: &str) -> impl Iterator<Item = (LineKind, &str)> {
    let mut can_open = true;
    let mut in_code = false;
    let mut in_list = false;
    markdown_lines(content).map(move |(kind, line)| {
        if kind != LineKind::Text {
            // Front matter or a fence may be followed by indented code.
            can_open = true;
            in_code = false;
            return (kind, line);
        }
        if line.trim().is_empty() {
            can_open = true;
            return (kind, line);
        }
        if indent_columns(line) >= 4 && (in_code || (can_open && !in_list)) {
            in_code = true;
            return (LineKind::IndentedCode, line);
        }
        in_code = false;
        let heading = atx_heading(line).is_some();
        if is_list_item(line) {
            in_list = true;
        } else if indent_columns(line) == 0 && (can_open || heading) {
            in_list = false;
        }
        can_open = heading;
        (kind, line)
    })
}

/// `line` without the four columns of indentation that make it indented
/// code (a tab reaches the next multiple of four).
#[allow(dead_code)]
pub fn without_code_indent(line: &str) -> &str {
    let mut col = 0;
    for (i, c) in line.char_indices() {
        if col >= 4 {
            return &line[i..];
        }
        match c {
            ' ' => col += 1,
            '\t' => col += 4 - col % 4,
            _ => return &line[i..],
        }
    }
    ""
}

/// How many columns of spaces and tabs `line` starts with, a tab reaching
/// the next multiple of four.
fn indent_columns(line: &str) -> usize {
    let mut col = 0;
    for c in line.chars() {
        match c {
            ' ' => col += 1,
            '\t' => col += 4 - col % 4,
            _ => break,
        }
    }
    col
}

/// Whether `line` starts a list item: at most three spaces, then `-`, `*`,
/// `+`, or 1 to 9 digits and `.` or `)`, then a space, a tab or the end.
fn is_list_item(line: &str) -> bool {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return false;
    }
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    let rest = if digits == 0 {
        body.strip_prefix(['-', '*', '+'])
    } else if digits <= 9 {
        body[digits..].strip_prefix(['.', ')'])
    } else {
        None
    };
    rest.is_some_and(|r| r.is_empty() || r.starts_with([' ', '\t']))
}
