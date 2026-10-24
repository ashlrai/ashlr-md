//! The lines of a Markdown text, each with what it is: part of a leading
//! YAML front matter block, a code fence, a line of fenced code, or text.
//! The app and mdopener-mcp (which includes this file) share it, so every
//! scanner that must not read code as Markdown (a document's title, the
//! headings, wikilinks and image count of `export_metadata`, the plain text
//! of `export_text`, the task checkboxes of `/annotations` and
//! `get_user_annotations`, the heading chunks of semantic search) uses one rule for front matter and one for fences.
//! [`atx_heading`] is the one ATX heading rule of a document's title and of
//! `export_metadata`'s headings.
//! Those scanners used to flip an "in code" flag on any line starting with
//! ```` ``` ```` or `~~~`, so a ```` ```` ```` block holding ```` ``` ````
//! ended early and a `~~~` line closed a backtick block.

use std::borrow::Cow;

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
    /// A line of an HTML block ([`html_start`]): raw HTML, which the page
    /// shows as HTML, not as Markdown.
    Html,
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
/// paragraph, inside blockquotes too (`> - a`, then `>   b`), where only
/// the items before the first blockquote used to be. A quoted fence, a list-item fence and then these used to be
/// text, so a `# comment` or a `[[link]]` in their code was read as
/// Markdown and `- [ ] x` as a task. The app's `outline.ts` reads lines by
/// the same rule.
///
/// An HTML block ([`html_start`]) is [`LineKind::Html`] in the same
/// containers, up to its end marker or, for a block tag or a lone tag, a
/// blank line, and a GFM footnote definition (`[^n]: x`) is a container
/// whose content goes on in the lines indented four columns after it, as
/// micromark reads them. Both used to be text, so a `# x` in a `<div>` was
/// a heading, a definition after `<!-- c -->` went on with a paragraph,
/// and a heading or a fence on a footnote's lines was paragraph text.
// mdopener-mcp uses it; the app includes this file only for its tasks.
#[allow(dead_code)]
pub fn markdown_lines(content: &str) -> impl Iterator<Item = (LineKind, &str)> {
    scan(content).map(|l| (l.kind, l.line))
}

/// For each line of `content`, as [`markdown_lines`] yields them, the code
/// of a [`LineKind::Code`] line or the HTML of a [`LineKind::Html`] line:
/// the line without the blockquote markers
/// and list item indentation its fence sits in, and without up to as many
/// spaces as the fence is indented, as CommonMark reads fenced code. For a
/// line [`with_indented_code`] marks [`LineKind::IndentedCode`], the line
/// without the markers and item indentation it sits in and the four
/// columns that make it code (a tab past them is kept). None for any other
/// line.
// mdopener-mcp uses it; the app includes this file only for its tasks.
#[allow(dead_code)]
pub fn line_code(content: &str) -> impl Iterator<Item = Option<Cow<'_, str>>> {
    scan(content).map(|l| l.code)
}

/// For each line of `content`, as [`markdown_lines`] yields them, the text
/// of a [`LineKind::Text`] line past the blockquote markers, list markers
/// and list item indentation it sits in (tabs expanded), by the container
/// rule fences follow, and whether the line opens a list item that holds
/// that text: `- # Step` is `# Step`, `> - a` is `a`, and an item's
/// continuation line (`- a`, then `  b`) is `b`. None for any other line.
pub fn line_text(content: &str) -> impl Iterator<Item = Option<(Cow<'_, str>, bool)>> {
    scan(content).map(|l| l.text.map(|t| (t, l.item)))
}

/// For each line of `content`, as [`markdown_lines`] yields them, the text
/// of a text line that is the first content of a list item ([`line_text`])
/// and not indented code: it opens the item (`- a`, `> - a`, `1. a`), or
/// follows a line that opened one with only its marker (`-`, then `  a`),
/// in that item or in a list item it is in (`- -`, then `  a`), as
/// micromark reads it. With it, whether the line goes on with the paragraph of the line
/// before, lazily (`- a`, then `b`) or in its containers, and whether it
/// is a setext heading underline, which makes that paragraph a heading.
/// Where a GFM task checkbox can be, as the renderer reads it
/// ([`crate::task_list`]). A marker followed by a space before the line
/// break (`- `, then `  a`) has no first content after it, as in
/// micromark.
pub fn item_starts(content: &str) -> impl Iterator<Item = ItemStart<'_>> {
    scan(content).map(|l| ItemStart {
        text: if l.first { l.text } else { None },
        continues: l.continues,
        underline: l.underline,
        footnote: l.footnote,
    })
}

/// A line of [`item_starts`].
pub struct ItemStart<'a> {
    /// The text of the line when it is the first content of a list item.
    pub text: Option<Cow<'a, str>>,
    /// Whether the line goes on with the paragraph of the line before.
    pub continues: bool,
    /// Whether the line is a setext heading underline.
    pub underline: bool,
    /// The label of the GFM footnote definition the line opens (`[^n]: x`
    /// is `n`), as micromark reads one: it may interrupt a paragraph, and
    /// its content goes on in the lines indented four columns.
    // mdopener-mcp uses it; the app reads only tasks.
    #[allow(dead_code)]
    pub footnote: Option<String>,
}

/// The ATX headings ([`atx_heading`]) of the text lines of `content`
/// ([`text_lines`]) that sit in no blockquote or list item, empty ones
/// included: a document's title and `export_metadata`'s headings. A line
/// behind `> ` or `- ` markers, or indented into an open item's content
/// column (`- x`, a blank line, then `  # Sub`), is in a container by the
/// rule fences follow, as the app's Outline reads it.
// mdopener-mcp uses it; the app includes this file only for its tasks.
#[allow(dead_code)]
pub fn document_headings(content: &str) -> impl Iterator<Item = (usize, &str)> {
    scan(content)
        .filter(|l| l.kind == LineKind::Text && !l.contained)
        .filter_map(|l| atx_heading(l.line))
}

/// A line of [`scan`].
struct Scanned<'a> {
    kind: LineKind,
    line: &'a str,
    /// The code of a code line ([`line_code`]).
    code: Option<Cow<'a, str>>,
    /// Whether the line is a line of indented code ([`with_indented_code`]).
    indented: bool,
    /// Whether the line sits in a blockquote or a list item.
    contained: bool,
    /// The text of a text line past its containers ([`line_text`]).
    text: Option<Cow<'a, str>>,
    /// Whether the line opens a list item that holds its text.
    item: bool,
    /// Whether the line is the first content of a list item: it opens the
    /// item, or comes right after a line that opened it with nothing.
    first: bool,
    /// Whether the line goes on with the paragraph of the line before.
    continues: bool,
    /// Whether the line is a setext heading underline.
    underline: bool,
    /// The label of the footnote definition the line opens (`[^n]: x`).
    footnote: Option<String>,
}

/// [`markdown_lines`], with each code line's code ([`line_code`]), whether
/// each line sits in a container and whether it is indented code.
fn scan(content: &str) -> impl Iterator<Item = Scanned<'_>> {
    let front_matter = front_matter_len(content);
    // The open fence (its character, its length and how far it is
    // indented), with the containers its code lines stay in.
    let mut fence: Option<(char, usize, usize, Vec<Container>)> = None;
    // The open HTML block (how it ends), with the containers it stays in.
    let mut html: Option<(HtmlEnd, Vec<Container>)> = None;
    // The open blockquotes and list items, outermost first: the containers
    // of the last line that was not blank or lazy, less those a blank line
    // or a closing line ended.
    let mut open: Vec<Container> = Vec::new();
    // How many containers hold the paragraph the line before is in, or
    // None after any other line.
    let mut paragraph: Option<usize> = None;
    // The containers of the paragraph's last line that was not lazy.
    let mut para_list: Vec<Container> = Vec::new();
    // The same for indented code, which a blank line does not end.
    let mut indented: Option<usize> = None;
    // Whether the innermost open item has only its marker so far.
    let mut bare = false;
    // Whether that marker has nothing after it, not even a space.
    let mut tight = false;
    // Whether the line before was in a blockquote or ended a bare item:
    // indented code after it closes a container.
    let mut closer = false;
    content.lines().enumerate().map(move |(i, line)| {
        if i < front_matter {
            return Scanned {
                kind: LineKind::FrontMatter,
                line,
                code: None,
                indented: false,
                contained: false,
                text: None,
                item: false,
                first: false,
                continues: false,
                underline: false,
                footnote: None,
            };
        }
        let expanded = expand_tabs(line);
        let mut ends_bare = false;
        let mut contained;
        let mut kind = LineKind::Text;
        let mut code = None;
        let mut indented_code = false;
        let mut text = None;
        let mut item = false;
        let mut first = false;
        let mut continues_paragraph = false;
        let mut underline = false;
        let mut footnote = None;
        // A line of an open HTML block: one that stays in its containers
        // and, for a block that ends at a blank line, is not blank.
        let in_html = html.as_ref().and_then(|(end, list)| {
            let inside = continues(&expanded, list)?;
            (*end != HtmlEnd::Blank || !inside.trim().is_empty()).then_some((inside, list))
        });
        let inside = fence
            .as_ref()
            .and_then(|(_, _, _, list)| continues(&expanded, list));
        if let Some((inside, list)) = in_html {
            contained = !list.is_empty();
            kind = LineKind::Html;
            code = Some(past(line, &expanded, inside));
            if html
                .as_ref()
                .is_some_and(|(end, _)| html_ends(*end, inside))
            {
                html = None;
            }
        } else if let (Some((c, n, indent, list)), Some(inside)) = (&fence, inside) {
            contained = !list.is_empty();
            kind = match code_fence(inside) {
                Some((rc, rn, tail)) if rc == *c && rn >= *n && tail.trim().is_empty() => {
                    LineKind::Fence
                }
                _ => LineKind::Code,
            };
            if kind == LineKind::Fence {
                fence = None;
            } else {
                let text = &inside[spaces_before(inside).min(*indent)..];
                code = Some(past(line, &expanded, text));
            }
        } else {
            fence = None;
            html = None;
            let (list, matched, rest, label) = containers(&expanded, &open, paragraph.or(indented));
            footnote = label;
            contained = !list.is_empty();
            let empty = rest.trim().is_empty();
            let opened = list.len() > matched;
            item = opened && matches!(list.last(), Some(Container::Item(_)));
            text = Some(past(line, &expanded, rest));
            if let Some((c, n, _)) = code_fence(rest) {
                text = None;
                item = false;
                open = list.clone();
                fence = Some((c, n, spaces_before(rest), list));
                kind = LineKind::Fence;
                paragraph = None;
                indented = None;
                bare = false;
            } else if empty && !opened {
                // A blank line ends the blockquotes it has no `>` for, and an
                // item that starts with one ends at a second.
                let ends = bare && matched == open.len();
                open = list;
                if ends {
                    open.pop();
                }
                ends_bare = bare;
                paragraph = None;
                bare = false;
            } else {
                let heading = atx_heading(rest).is_some();
                let block = html_start(rest);
                // An HTML block of the first six kinds interrupts a
                // paragraph, as a heading does; one of the seventh kind (a
                // lone tag, `<u>`) does not.
                let interrupts = heading || block.is_some_and(|b| b != HtmlEnd::Blank7);
                // A paragraph goes on in a line that leaves an item without
                // opening one, or a blockquote (lazy continuation).
                let lazy = paragraph.is_some() && !interrupts && !opened && matched < open.len();
                if paragraph == Some(matched) && !opened && setext_underline(rest) {
                    // A setext underline ends the paragraph as a heading.
                    underline = true;
                    open.truncate(matched);
                    paragraph = None;
                    indented = None;
                    bare = false;
                } else if thematic_break(rest) {
                    // A thematic break ends the containers it is not in.
                    open = list;
                    paragraph = None;
                    indented = None;
                    bare = false;
                } else if lazy && block == Some(HtmlEnd::Blank7) {
                    // A lone tag on a lazy line opens an HTML block in the
                    // containers the paragraph is in, as micromark reads it
                    // (`> a`, then `<u>`).
                    contained = !open.is_empty();
                    kind = LineKind::Html;
                    code = text.take();
                    html = Some((HtmlEnd::Blank, open.clone()));
                    paragraph = None;
                    indented = None;
                    bare = false;
                } else if !lazy {
                    // Indented code that closed a container without opening
                    // one, or after a bare item's end, does not hold the
                    // next line's markers; one that opens a blockquote
                    // (`-`, a blank line, then `>     code`) does.
                    let closed = (matched < open.len() || closer) && !opened;
                    // Only a marker with nothing after it, not even a
                    // space, has its first content on the next line, at
                    // its content column. The renderer reads that line's
                    // paragraph as first content also when the line leaves
                    // the bare item for an item it is in (`- -`, then
                    // `  [ ] t`), but not for a blockquote.
                    let after_bare = bare
                        && tight
                        && !opened
                        && matches!(list.last(), Some(Container::Item(_)))
                        && spaces_before(rest) == 0;
                    open = list.clone();
                    bare = opened && empty && matches!(list.last(), Some(Container::Item(_)));
                    tight = bare && !line.ends_with([' ', '\t']);
                    let level = list.len();
                    // Four spaces past the containers is indented code, not text.
                    // A paragraph goes on unless the line opens a list
                    // item, or a blockquote the paragraph is not in.
                    let fresh = paragraph.is_none()
                        || list[matched..].iter().any(|c| *c != Container::Quote)
                        || (opened && !para_list.starts_with(&list));
                    if let Some(end) = block.filter(|&b| b != HtmlEnd::Blank7 || fresh) {
                        // An HTML block, which ends at its end marker (on
                        // this line too) or, for the last two kinds, at a
                        // blank line.
                        kind = LineKind::Html;
                        code = text.take();
                        item = false;
                        bare = false;
                        paragraph = None;
                        indented = None;
                        let end = if end == HtmlEnd::Blank7 {
                            HtmlEnd::Blank
                        } else {
                            end
                        };
                        let opener = rest.trim_start_matches(' ');
                        if !html_ends(end, &opener[end.opener_len(opener)..]) {
                            html = Some((end, list));
                        }
                        closer = false;
                        return Scanned {
                            kind,
                            line,
                            code,
                            indented: false,
                            contained,
                            text,
                            item,
                            first,
                            continues: false,
                            underline,
                            footnote,
                        };
                    }
                    indented_code = fresh && !empty && spaces_before(rest) >= 4;
                    continues_paragraph = !fresh && !heading && !empty;
                    // The first content of an item opened by a bare marker
                    // may be on the line after it (`-`, then `  [ ] t`).
                    first = !indented_code && !empty && (item || after_bare);
                    if indented_code {
                        let columns = expanded.len() - rest.len() + 4;
                        code = Some(past_columns(line, columns));
                    }
                    paragraph = (!heading && !empty && !indented_code).then_some(level);
                    para_list = list;
                    // Only indented code that closed no container, as the
                    // renderer reads it.
                    indented = (indented_code && !closed).then_some(level);
                } else {
                    continues_paragraph = true;
                }
            }
        }
        closer = ends_bare;
        Scanned {
            kind,
            line,
            code,
            indented: indented_code,
            contained,
            text,
            item,
            first,
            continues: continues_paragraph,
            underline,
            footnote,
        }
    })
}

/// A container a line can sit in, from [`containers`]: a blockquote, or a
/// list item with how many columns its content is past the container
/// before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Container {
    Quote,
    Item(usize),
    /// A GFM footnote definition (`[^n]: x`), whose content goes on in the
    /// lines indented four columns past the container before it.
    Footnote,
}

/// The columns a footnote definition's content goes on at, past the
/// container before it.
const FOOTNOTE_WIDTH: usize = 4;

/// How an HTML block ends, by the kind its first line opens
/// ([`html_start`]), as CommonMark numbers them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HtmlEnd {
    /// 1: `<pre`, `<script`, `<style` or `<textarea`, ended by a line
    /// holding `</pre>`, `</script>`, `</style>` or `</textarea>`.
    Raw,
    /// 2: `<!--`, ended by `-->`.
    Comment,
    /// 3: `<?`, ended by `?>`.
    Instruction,
    /// 4: `<!` and a letter, ended by `>`.
    Declaration,
    /// 5: `<![CDATA[`, ended by `]]>`.
    Cdata,
    /// 6: a block-level tag (`<div>`, `</p>`), ended by a blank line.
    Blank,
    /// 7: any other whole open or closing tag alone on its line (`<u>`),
    /// ended by a blank line; it cannot interrupt a paragraph.
    Blank7,
}

impl HtmlEnd {
    /// How many bytes of `opener` (the line from its `<`) come before the
    /// text its end marker is looked for in: `<!-->` and `<?>` end on
    /// their first line, as micromark reads them.
    fn opener_len(self, opener: &str) -> usize {
        match self {
            HtmlEnd::Raw => {
                1 + opener[1..]
                    .bytes()
                    .take_while(u8::is_ascii_alphanumeric)
                    .count()
            }
            HtmlEnd::Comment | HtmlEnd::Declaration => 2,
            HtmlEnd::Instruction => 1,
            HtmlEnd::Cdata => 9,
            HtmlEnd::Blank | HtmlEnd::Blank7 => 0,
        }
    }
}

/// The tag names of an HTML block of the sixth kind, as micromark lists
/// them.
const HTML_BLOCK_NAMES: &[&str] = &[
    "address",
    "article",
    "aside",
    "base",
    "basefont",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "menuitem",
    "nav",
    "noframes",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "search",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
];

/// The tag names of an HTML block of the first kind.
const HTML_RAW_NAMES: &[&str] = &["pre", "script", "style", "textarea"];

/// How the HTML block that `line` (tabs expanded, past its containers)
/// opens ends, when it opens one, as CommonMark and micromark read it: at
/// most three spaces, then `<` and one of the seven openings of
/// [`HtmlEnd`]. A line of the seventh kind is a whole open tag (a tag
/// name, attributes with optional quoted or unquoted values, an optional
/// `/`) or closing tag with only spaces after it.
fn html_start(line: &str) -> Option<HtmlEnd> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let after = body.strip_prefix('<')?;
    if after.starts_with("!--") {
        return Some(HtmlEnd::Comment);
    }
    if after.starts_with('?') {
        return Some(HtmlEnd::Instruction);
    }
    if after.starts_with("![CDATA[") {
        return Some(HtmlEnd::Cdata);
    }
    if after
        .strip_prefix('!')
        .is_some_and(|a| a.starts_with(|c: char| c.is_ascii_alphabetic()))
    {
        return Some(HtmlEnd::Declaration);
    }
    let closing = after.starts_with('/');
    let tag = if closing { &after[1..] } else { after };
    if !tag.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    let len = tag
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'-')
        .count();
    let name = tag[..len].to_ascii_lowercase();
    let next = &tag[len..];
    let ends_name = next.is_empty() || next.starts_with([' ', '\t', '>']);
    if !closing && ends_name && HTML_RAW_NAMES.contains(&name.as_str()) {
        return Some(HtmlEnd::Raw);
    }
    if (ends_name || next.starts_with("/>")) && HTML_BLOCK_NAMES.contains(&name.as_str()) {
        return Some(HtmlEnd::Blank);
    }
    let end = if closing {
        let gap = next.trim_start_matches([' ', '\t']);
        gap.strip_prefix('>')
    } else {
        open_tag_end(next)
    }?;
    end.trim_matches([' ', '\t'])
        .is_empty()
        .then_some(HtmlEnd::Blank7)
}

/// The rest of `tag` (an open tag past its name) after the tag's
/// attributes, optional `/` and `>`, when it closes on the line.
fn open_tag_end(mut tag: &str) -> Option<&str> {
    loop {
        let gap = tag.trim_start_matches([' ', '\t']);
        if let Some(rest) = gap.strip_prefix('>') {
            return Some(rest);
        }
        if let Some(rest) = gap.strip_prefix("/>") {
            return Some(rest);
        }
        // An attribute needs a space before it.
        if gap.len() == tag.len()
            || !gap.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_' || c == ':')
        {
            return None;
        }
        let name = gap
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(b))
            .count();
        tag = &gap[name..];
        let eq = tag.trim_start_matches([' ', '\t']);
        if let Some(value) = eq.strip_prefix('=') {
            let value = value.trim_start_matches([' ', '\t']);
            tag = match value.chars().next()? {
                q @ ('"' | '\'') => {
                    let close = value[1..].find(q)?;
                    &value[close + 2..]
                }
                _ => {
                    let len = value
                        .find(|c: char| c.is_whitespace() || "\"'=<>`".contains(c))
                        .unwrap_or(value.len());
                    if len == 0 {
                        return None;
                    }
                    &value[len..]
                }
            };
        }
    }
}

/// Whether `line` (past the containers of its HTML block, or past the
/// opening of the block's first line) ends an HTML block that ends by
/// `end`.
fn html_ends(end: HtmlEnd, line: &str) -> bool {
    match end {
        HtmlEnd::Raw => {
            let lower = line.to_ascii_lowercase();
            HTML_RAW_NAMES
                .iter()
                .any(|name| lower.contains(&format!("</{name}>")))
        }
        HtmlEnd::Comment => line.contains("-->"),
        HtmlEnd::Instruction => line.contains("?>"),
        HtmlEnd::Declaration => line.contains('>'),
        HtmlEnd::Cdata => line.contains("]]>"),
        HtmlEnd::Blank | HtmlEnd::Blank7 => false,
    }
}

/// The label of the GFM footnote definition `line` (tabs expanded) opens
/// and the rest of the line past its `:` and the spaces after it, when it
/// opens one, as micromark reads it: at most three spaces, `[^`, a label of
/// 1 to 999 characters with no space and no unescaped bracket, then `]:`.
/// `[^a b]: x` and `[^]: x` are link reference definitions.
fn footnote_marker(line: &str) -> Option<(&str, &str)> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let inner = body.strip_prefix("[^")?;
    let mut escaped = false;
    for (n, (i, c)) in inner.char_indices().enumerate() {
        match c {
            _ if n >= 999 => return None,
            c if c.is_whitespace() => return None,
            '[' | '\\' | ']' if escaped => escaped = false,
            ']' if n > 0 => {
                let rest = inner[i + 1..].strip_prefix(':')?;
                return Some((&inner[..i], rest.trim_start_matches(' ')));
            }
            '[' | ']' => return None,
            '\\' => escaped = true,
            _ => escaped = false,
        }
    }
    None
}

/// `rest`, the end of `expanded` (`line` with its tabs expanded), as a
/// part of `line` when `line` has no tab to expand.
fn past<'a>(line: &'a str, expanded: &Cow<'a, str>, rest: &str) -> Cow<'a, str> {
    match expanded {
        Cow::Borrowed(_) => Cow::Borrowed(&line[line.len() - rest.len()..]),
        Cow::Owned(_) => Cow::Owned(rest.to_string()),
    }
}

/// `line` with each tab replaced by the spaces that reach the next multiple
/// of four columns, as CommonMark reads indentation.
fn expand_tabs(line: &str) -> Cow<'_, str> {
    if !line.contains('\t') {
        return Cow::Borrowed(line);
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
    Cow::Owned(out)
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
/// containers `open` (outermost first) it continues, and the rest of the
/// line: first those it continues, each blockquote by its `>` and each
/// list item by its content indentation (a blank line stays in an item),
/// then the blockquote markers and list markers it opens (`> `, `- `,
/// `1. - `, `- > `). An item in a blockquote (`> - a`, then `>   b`) holds
/// the lines indented into it, as an item outside one does; only the items
/// before the first blockquote used to be tracked. When the line would
/// otherwise continue a paragraph held by `held` containers (or indented
/// code, which the renderer treats alike), a list marker that opens no
/// text (`-` alone) or an ordered one that does not start at 1 is text,
/// also past a blockquote or an item the line opens, as the renderer reads
/// it. A thematic break (`- - -`) opens no item. The app's `outline.ts`
/// reads containers by the same rule.
fn containers<'a>(
    line: &'a str,
    open: &[Container],
    held: Option<usize>,
) -> (Vec<Container>, usize, &'a str, Option<String>) {
    let mut list = Vec::new();
    let mut rest = line;
    for c in open {
        match continue_one(rest, *c) {
            Some(after) => rest = after,
            None => break,
        }
        list.push(*c);
    }
    let matched = list.len();
    let interrupt = held == Some(matched);
    let mut footnote = None;
    loop {
        if let Some(after) = quote_marker(rest) {
            list.push(Container::Quote);
            rest = after;
            continue;
        }
        // A footnote definition, which may interrupt a paragraph.
        if let Some((label, after)) = footnote_marker(rest) {
            list.push(Container::Footnote);
            footnote = Some(label.to_string());
            rest = after;
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
    (list, matched, rest, footnote)
}

/// The rest of `line` (tabs expanded) past the open container `c`, when
/// the line goes on in it: a blockquote by its `>`, a list item by its
/// content indentation and a footnote definition by four columns (a blank
/// line stays in both).
fn continue_one(rest: &str, c: Container) -> Option<&str> {
    let width = match c {
        Container::Quote => return quote_marker(rest),
        _ if rest.trim().is_empty() => return Some(""),
        Container::Item(width) => width,
        Container::Footnote => FOOTNOTE_WIDTH,
    };
    (spaces_before(rest) >= width).then(|| &rest[width..])
}

/// The rest of `line` (tabs expanded) inside the containers `list` of an
/// open fence, or None when the line leaves one of them: a blockquote
/// needs its `>` (a blank line has none), and a list item needs its
/// content indentation unless the line is blank.
fn continues<'a>(line: &'a str, list: &[Container]) -> Option<&'a str> {
    let mut rest = line;
    for c in list {
        rest = continue_one(rest, *c)?;
    }
    Some(rest)
}

/// The lines of `content` that are Markdown text: not front matter, not a
/// fence and not fenced code.
// mdopener-mcp uses it; the app includes this file only for its tasks.
#[allow(dead_code)]
pub fn text_lines(content: &str) -> impl Iterator<Item = &str> {
    markdown_lines(content)
        .filter(|(kind, _)| *kind == LineKind::Text)
        .map(|(_, line)| line)
}

/// How many lines a leading front matter block takes, its two delimiters
/// included; 0 when there is none. Each delimiter starts at column 0 and
/// only spaces and tabs may follow it, as remark-frontmatter reads it: the
/// line was trimmed, so `  ---` opened front matter that the page shows as
/// a thematic break, and the lines after it were left out of the headings,
/// tasks and text.
pub fn front_matter_len(content: &str) -> usize {
    fn delimiter(line: &str) -> &str {
        line.trim_end_matches([' ', '\t', '\r'])
    }
    let mut lines = content.lines();
    if lines.next().map(delimiter) != Some("---") {
        return 0;
    }
    lines
        .position(|l| matches!(delimiter(l), "---" | "..."))
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
/// [`LineKind::IndentedCode`]: a line indented four columns or more past
/// the blockquote markers and list item content it sits in (a tab reaches
/// the next multiple of four) that does not continue a paragraph, and the
/// indented lines after it; the blank lines between them stay text. In a
/// list item that is four columns past the item's content column (`- a`, a
/// blank line, then six spaces), by the container rule fences follow, so
/// an item's indented continuation is text and its indented code is code.
/// After a list item an indented line used to be read as text until the
/// list ended, so code in an item lost its `#`s and `*`s.
#[allow(dead_code)]
pub fn with_indented_code(content: &str) -> impl Iterator<Item = (LineKind, &str)> {
    scan(content).map(|l| {
        let kind = if l.indented {
            LineKind::IndentedCode
        } else {
            l.kind
        };
        (kind, l.line)
    })
}

/// `line` without its first `columns` columns of ASCII containers and
/// indentation (a tab reaches the next multiple of four). A tab that runs
/// past them leaves its remaining columns as spaces.
fn past_columns(line: &str, columns: usize) -> Cow<'_, str> {
    let mut col = 0;
    for (i, b) in line.bytes().enumerate() {
        if col >= columns {
            return if col == columns {
                Cow::Borrowed(&line[i..])
            } else {
                Cow::Owned(format!("{}{}", " ".repeat(col - columns), &line[i..]))
            };
        }
        col = if b == b'\t' {
            col + 4 - col % 4
        } else {
            col + 1
        };
    }
    if col > columns {
        Cow::Owned(" ".repeat(col - columns))
    } else {
        Cow::Borrowed("")
    }
}
