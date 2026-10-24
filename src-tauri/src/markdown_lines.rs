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
///
/// A fence may sit in blockquotes and list items, as in CommonMark: behind
/// `> ` markers, after list markers (`- `, `1. - `, `-` then a tab), in a
/// quote in an item (`- > `), or on an item's continuation line indented
/// to its content column (`- a`, a blank line, then two spaces and a
/// fence), nested items included however deep (`containers`). The lines
/// after it that stay in those containers (each quote's `>`, each item's
/// content indentation, a blank line staying in an item but ending a
/// quote) are its code until a closing fence in them, and a line that
/// leaves one ends the block. Open list items are tracked across text
/// lines, a less indented line ending them unless it continues a
/// paragraph. A quoted fence, a list-item fence and then these used to be
/// text, so a `# comment` or a `[[link]]` in their code was read as
/// Markdown and `- [ ] x` as a task. The app's `outline.ts` reads lines by
/// the same rule.
pub fn markdown_lines(content: &str) -> impl Iterator<Item = (LineKind, &str)> {
    let front_matter = front_matter_len(content);
    // The open fence, with the containers its code lines stay in.
    let mut fence: Option<(char, usize, Vec<Container>)> = None;
    // The widths of the open list items, outermost first.
    let mut items: Vec<usize> = Vec::new();
    // How many open items hold the paragraph the line before is in (-1 for
    // one in a blockquote), or None after any other line.
    let mut paragraph: Option<isize> = None;
    // The same for indented code, which a blank line does not end.
    let mut indented: Option<isize> = None;
    // Whether the innermost open item has only its marker so far.
    let mut bare = false;
    // Whether the line before was in a blockquote or ended a bare item:
    // indented code after it closes a container.
    let mut closer = false;
    content.lines().enumerate().map(move |(i, line)| {
        if i < front_matter {
            return (LineKind::FrontMatter, line);
        }
        let expanded = expand_tabs(line);
        let mut ends_bare = false;
        let quoted;
        let mut kind = LineKind::Text;
        let inside = fence
            .as_ref()
            .and_then(|(_, _, list)| continues(&expanded, list));
        if let (Some((c, n, list)), Some(inside)) = (&fence, inside) {
            quoted = list.contains(&Container::Quote);
            kind = match code_fence(inside) {
                Some((rc, rn, tail)) if rc == *c && rn >= *n && tail.trim().is_empty() => {
                    LineKind::Fence
                }
                _ => LineKind::Code,
            };
            if kind == LineKind::Fence {
                fence = None;
            }
        } else {
            fence = None;
            let (list, matched, rest) = containers(&expanded, &items, paragraph.or(indented));
            quoted = list.contains(&Container::Quote);
            let empty = rest.trim().is_empty();
            let opened = list.len() > matched;
            if let Some((c, n, _)) = code_fence(rest) {
                items = leading_items(&list);
                fence = Some((c, n, list));
                kind = LineKind::Fence;
                paragraph = None;
                indented = None;
                bare = false;
            } else if empty && !opened {
                // A blank line. An item that starts with one ends at a second.
                if bare {
                    items.pop();
                }
                ends_bare = bare;
                paragraph = None;
                bare = false;
            } else {
                let heading = atx_heading(rest).is_some();
                // A paragraph goes on in a line that leaves an item without
                // opening one, or a blockquote (lazy continuation).
                let lazy = paragraph.is_some()
                    && !heading
                    && !opened
                    && (matched < items.len() || paragraph == Some(-1));
                if paragraph == Some(matched as isize) && !opened && setext_underline(rest) {
                    // A setext underline ends the paragraph as a heading.
                    items.truncate(matched);
                    paragraph = None;
                    indented = None;
                    bare = false;
                } else if thematic_break(rest) {
                    // A thematic break ends the items it is not indented into.
                    items = leading_items(&list);
                    paragraph = None;
                    indented = None;
                    bare = false;
                } else if !lazy {
                    let closed = matched < items.len() || closer;
                    items = leading_items(&list);
                    bare = opened && empty && list.last() != Some(&Container::Quote);
                    let level = if quoted { -1 } else { items.len() as isize };
                    // Four spaces past the containers is indented code, not text.
                    let code =
                        (opened || paragraph.is_none()) && !empty && spaces_before(rest) >= 4;
                    paragraph = (!heading && !empty && !code).then_some(level);
                    // Only indented code that closed no container, as the
                    // renderer reads it.
                    indented = (code && !closed).then_some(level);
                }
            }
        }
        closer = ends_bare || quoted;
        (kind, line)
    })
}

/// A container a line can sit in, from [`containers`]: a blockquote, or a
/// list item with how many columns its content is past the container
/// before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Container {
    Quote,
    Item(usize),
}

/// `line` with each tab replaced by the spaces that reach the next multiple
/// of four columns, as CommonMark reads indentation.
fn expand_tabs(line: &str) -> std::borrow::Cow<'_, str> {
    if !line.contains('\t') {
        return std::borrow::Cow::Borrowed(line);
    }
    let mut out = String::with_capacity(line.len() + 8);
    let mut column = 0;
    for c in line.chars() {
        if c == '\t' {
            let n = 4 - column % 4;
            out.push_str(&" ".repeat(n));
            column += n;
        } else {
            out.push(c);
            column += 1;
        }
    }
    std::borrow::Cow::Owned(out)
}

/// How many spaces `line` (tabs expanded) starts with.
fn spaces_before(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// `line` (tabs expanded) without the blockquote marker that opens it (at
/// most three spaces, `>`, then one optional space), when it has one.
fn quote_marker(line: &str) -> Option<&str> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let after = body.strip_prefix('>')?;
    Some(after.strip_prefix(' ').unwrap_or(after))
}

/// The content column of the list item `line` (tabs expanded) opens, past
/// the line's start, the rest of the line, and whether the item may
/// interrupt a paragraph by its marker (false for an ordered item that
/// does not start at 1), when it opens one: at most three spaces, `-`,
/// `*`, `+` or 1 to 9 digits and `.` or `)`, then one to four spaces
/// before the text. An item with nothing after its marker, or with five or
/// more spaces (indented code), has its content one column past the
/// marker, as in CommonMark.
fn list_marker(line: &str) -> Option<(usize, &str, bool)> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    let (after, one) = if digits == 0 {
        (body.strip_prefix(['-', '*', '+'])?, true)
    } else if digits <= 9 {
        let after = body[digits..].strip_prefix(['.', ')'])?;
        (after, body[..digits].parse::<u32>() == Ok(1))
    } else {
        return None;
    };
    let end = line.len() - after.len();
    let spaces = spaces_before(after);
    if after.trim().is_empty() {
        Some((end + 1, "", one))
    } else if spaces == 0 {
        None
    } else if spaces > 4 {
        Some((end + 1, &after[1..], one))
    } else {
        Some((end + spaces, &after[spaces..], one))
    }
}

/// Whether `line` (tabs expanded) is a thematic break: at most three
/// spaces, then three or more `-`, `*` or `_`, spaces between them allowed.
fn thematic_break(line: &str) -> bool {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return false;
    }
    let Some(c) = body.chars().next().filter(|c| matches!(c, '-' | '*' | '_')) else {
        return false;
    };
    body.chars().all(|x| x == c || x == ' ') && body.chars().filter(|&x| x == c).count() >= 3
}

/// Whether `line` (tabs expanded) is a setext heading underline: at most
/// three spaces, then a run of `-` or of `=`, then only spaces.
fn setext_underline(line: &str) -> bool {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return false;
    }
    let body = body.trim_end_matches(' ');
    !body.is_empty() && (body.bytes().all(|b| b == b'-') || body.bytes().all(|b| b == b'='))
}

/// The containers `line` (tabs expanded) sits in, how many of the open
/// list items `items` (their widths, outermost first) it continues by its
/// indentation, and the rest of the line: first those items, then the
/// blockquote markers and list markers it opens (`> `, `- `, `1. - `,
/// `- > `). When the line would otherwise continue a paragraph held by
/// `held` of the items (or indented code, which the renderer treats
/// alike), a list marker that opens no text (`-` alone) or an ordered one
/// that does not start at 1 is text, as in CommonMark, until a blockquote
/// opens. A thematic break (`- - -`) opens no item. The app's `outline.ts`
/// reads containers by the same rule.
fn containers<'a>(
    line: &'a str,
    items: &[usize],
    held: Option<isize>,
) -> (Vec<Container>, usize, &'a str) {
    let mut list = Vec::new();
    let mut rest = line;
    for &width in items {
        if spaces_before(rest) < width {
            break;
        }
        rest = &rest[width..];
        list.push(Container::Item(width));
    }
    let matched = list.len();
    let mut interrupt = held == Some(matched as isize);
    loop {
        if let Some(after) = quote_marker(rest) {
            list.push(Container::Quote);
            rest = after;
            interrupt = false;
            continue;
        }
        if thematic_break(rest) {
            break;
        }
        match list_marker(rest) {
            Some((width, after, one)) if !(interrupt && (!one || after.trim().is_empty())) => {
                list.push(Container::Item(width));
                rest = after;
            }
            _ => break,
        }
    }
    (list, matched, rest)
}

/// The rest of `line` (tabs expanded) inside the containers `list` of an
/// open fence, or None when the line leaves one of them: a blockquote
/// needs its `>` (a blank line has none), and a list item needs its
/// content indentation unless the line is blank.
fn continues<'a>(line: &'a str, list: &[Container]) -> Option<&'a str> {
    let mut rest = line;
    for c in list {
        match *c {
            Container::Quote => rest = quote_marker(rest)?,
            Container::Item(_) if rest.trim().is_empty() => rest = "",
            Container::Item(width) if spaces_before(rest) >= width => rest = &rest[width..],
            Container::Item(_) => return None,
        }
    }
    Some(rest)
}

/// The widths of the list items that open `list`, before any blockquote.
fn leading_items(list: &[Container]) -> Vec<usize> {
    list.iter()
        .map_while(|c| match c {
            Container::Item(width) => Some(*width),
            Container::Quote => None,
        })
        .collect()
}

/// `line` without up to `max` leading blockquote markers (at most three
/// spaces, `>`, then one optional space or tab), and how many it lost.
// mdopener-mcp uses it; the app includes this file only for its tasks.
#[allow(dead_code)]
pub fn strip_quote_markers(line: &str, max: usize) -> (usize, &str) {
    let mut rest = line;
    let mut markers = 0;
    while markers < max {
        let body = rest.trim_start_matches(' ');
        if rest.len() - body.len() > 3 {
            break;
        }
        let Some(after) = body.strip_prefix('>') else {
            break;
        };
        rest = after.strip_prefix([' ', '\t']).unwrap_or(after);
        markers += 1;
    }
    (markers, rest)
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
/// A line in a blockquote (`> # Quote`) is not one: Obsidian's outline
/// lists no quoted heading, and the app's Outline panel reads it the same
/// way, so quoted text from elsewhere does not clutter either.
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
