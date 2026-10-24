# Changelog

All notable changes to Ashlr MD are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.4.1] — Unreleased

### Changed
- **AI and embedding errors no longer carry secrets.** An Anthropic error quoted
  the endpoint's whole response body, so a gateway that names the rejected
  `x-api-key` put the key into the AI sidebar's error. Ollama and embedding errors
  carried the base URL's path (where a proxy token can sit) through the HTTP
  client's message, and an Ollama error body could quote the `Authorization: Basic`
  value built from an `OLLAMA_HOST` user name and password. Error bodies are now
  redacted (the key, and the credentials, path segments and query values of the
  base URL) and cut to 300 characters, and client errors omit the URL. A new test
  drives each of these calls against a 401 that echoes the request, a redirect, a
  closed port and a malformed 200, and fails on any 8-character run of a secret.
- **Docs: running under `phantom exec`.** `docs/PHANTOM.md` lists the settings Ashlr MD
  reads (`ANTHROPIC_BASE_URL`, `OLLAMA_HOST` for the app and the sidecar) and their
  rules. It notes that the Anthropic key comes from Settings, not `ANTHROPIC_API_KEY`,
  and that `phm:` references are never resolved. It also covers LiteLLM: 1.83.0 or
  newer, preferring a current release.
- **MCP sidecar: https Ollama.** The sidecar now speaks `https://` to Ollama
  (system TLS through `native-tls`, already in the workspace). `OLLAMA_HOST`
  follows the `ANTHROPIC_BASE_URL` rules: `https://` to any host, or plain
  `http://` only to `127.0.0.1` or `[::1]`; `:port`, `0.0.0.0` and `[::]` map
  to loopback. Plain http to any other host, `localhost` by name, a user name or
  password, a query or fragment and other schemes are refused before any
  connection, and the refusal does not echo the value. Redirects are refused,
  not followed. The default (`http://127.0.0.1:11434`) is unchanged.

### Added
- **Anthropic key from the environment (opt-in).** With
  `ASHLR_MD_ANTHROPIC_KEY_FROM_ENV=1` the AI sidebar uses `ANTHROPIC_API_KEY` instead
  of the Settings key, so a `phm_` placeholder from `phantom exec` works. A placeholder
  must go to the session's loopback proxy (`ANTHROPIC_BASE_URL` under the #137 rules,
  on `PHANTOM_PROXY_PORT`). The value stays in Rust: it is never sent to the webview,
  saved, logged or put in an error. Settings stays the default. Anthropic request
  errors no longer include the URL.
- **Phantom installed check in setup output.** `scripts/install.sh` now prints whether
  the optional Phantom CLI is installed and its version. The check
  (`scripts/phantom-check.sh`) only runs `phantom --version`. It never runs
  `phantom reveal`, never reads the vault or `.env` files, and never captures
  secret values.
- **Custom AI endpoints.** `ANTHROPIC_BASE_URL` and `OLLAMA_HOST` override the
  Anthropic and Ollama hosts used by the AI sidebar, semantic search and the MCP
  sidecar, so a LiteLLM gateway or Phantom proxy can sit in front. Defaults are
  unchanged.
- **Copy as rich text.** A new command (⌘⇧C / palette: "Copy as rich text")
  copies the current document to the clipboard as formatted rich text. The
  clipboard entry carries both `text/html` (the rendered document) and
  `text/plain` (the Markdown source), so pasting into Gmail, Slack, Word, or
  Notion keeps headings, bold, lists, links, code, and tables, while pasting
  into a plain editor yields the raw Markdown. Falls back to a plain-text copy
  where the rich clipboard API is unavailable.
- **Structured summary for agent review documents.** When an AI agent writes a
  code-review or findings report — a list of findings each tagged with a
  severity (Critical / High / Medium / Low / Blocker / Major / Minor / Nit /
  Info), often with `Confidence:` lines and `path/to/file.ext:123` references —
  the read view now shows a scannable summary card at the top: color-coded
  severity counts, the total finding count, average confidence, and quick links
  that scroll to each finding. Detection is conservative (it requires at least
  two severity-tagged findings in structural positions, so ordinary prose that
  merely uses the word "critical" is never affected) and the body Markdown
  renders exactly as before beneath the card.
- **Paste images straight into a document.** Pasting an image from the clipboard
  while editing saves it into an `assets/` folder next to the file and inserts a
  relative `![](assets/…)` embed at the cursor. Works in both the source and
  WYSIWYG editors; the write is confined to the document's own folder. Save the
  document first (an unsaved doc has nowhere to put the image).
- **Accessibility pass.** Real focus-trapping with focus-restore for the
  Preferences and Export dialogs; closed side docks are now `inert` (their
  controls leave the tab order and screen-reader tree instead of being reachable
  while off-screen); clearer focus outlines across all themes; higher-contrast
  muted text (notably in Sepia); and motion is calmed under
  `prefers-reduced-motion`.

### Security
- **An exported page runs no script.** A template's CSS went into the
  exported HTML's `<style>` as written, so a `</style>` in it ended the element
  and the rest parsed as markup, an event handler included. The editor now
  refuses such CSS, the export escapes a `</style` from a template saved
  earlier, and exported HTML carries a policy of `script-src 'none'`.
- **A headless export never writes through a symbolic link.** The `export` MCP
  tool and the app's `/export` checked an `output_path` by its name's extension,
  and an HTML export is written through a link into the file it points to, so
  `report.html` linked to `~/.bashrc` had the export written over the shell
  profile. An output path that is a symbolic link is now refused.
- **Setting: Load remote images.** A web image in a document
  (`![](https://host/pixel.png)`, or an `<img>` or `<picture>` in its HTML) is
  fetched as the document renders, which tells that host the document was
  opened. Settings now has "Load remote images". It is on by default, which
  keeps today's behaviour so no document's images go missing. Off, web images
  in the read view, the editor and link previews are not fetched: they show as
  placeholders, and a bar over the document offers "Load remote images" for
  that document for the session. The choice is enforced in the renderer, not
  the webview's Content Security Policy: the policy (`img-src ... https:` in
  `src-tauri/tauri.conf.json`) is fixed when the app starts and cannot follow a
  setting, so it is unchanged. Exports and copies show what the read view shows:
  a blocked image is exported as its placeholder text, so load the images
  first to include them.
- **A wikilink can no longer show or open any file on the computer.**
  `resolve_wikilink` returned whatever existing file a target named, so a
  note from a cloned repository or a shared vault holding
  `![[../../.ssh/config]]` or `![[/etc/hosts]]` showed that file inline in
  the read view with no click (and put it into exports and the clipboard),
  and a click on `[[../../.aws/credentials]]` opened it in a tab, where
  agents read it. A wikilink now resolves only to a Markdown note, an image,
  a canvas or a PDF, inside the vault when there is one, through no hidden
  folder or file, and never by an absolute path.
- **`ANTHROPIC_BASE_URL` is validated before the key is sent (changes #131).**
  The override was used as given. It now must be `https://`, or plain
  `http://` only for `127.0.0.1` or `[::1]` (not the name `localhost`). Any
  other host over http, other schemes, malformed URLs, userinfo, a query or a
  fragment are refused at request time with a clear error, before any network
  call, so the API key is not sent. Anthropic requests no longer follow
  redirects, so the key goes only to the validated host. The error never
  echoes the value. Unset still means `https://api.anthropic.com`.
- **HTML in an AI answer is shown as text.** The AI sidebar's markdown
  renderer escaped only code spans, so HTML a model wrote in plain text
  (an `<img src=x onerror=...>`, a `<script>`, an `<a href="javascript:...">`)
  went into the app window as-is, where it could run script. The renderer now
  escapes all of an answer before applying its bold, italics, code, list and
  link formatting, and it builds a link only for an `http`, `https` or
  `mailto` URL; any other link keeps its text and drops the URL. Links open
  outside the app. Provider errors, the selection popover and the editors'
  inline AI already showed their text as text.

### Fixed
- **A task item that starts with `> [!TIP]` keeps it when edited.** The
  editor writes a task item's text as if it began a line, so `- [ ] > [!TIP]`
  was saved as `- [ ] \> \[!TIP]` once the item was edited (and `# x` as
  `\# x`). After the `[ ]` box none of these can start a block, so a `>`,
  `#`, `-`, `+` or `*` and a callout marker at the start of a task item's
  text are now saved as the file wrote them. Text the file wrote escaped
  stays escaped.
- **Email export: a code block's text is not styled as inline code.** The
  email profile gave every `<code>` the inline-code style (pink text in a grey
  box with a border), and as an inline style it beat the stylesheet's
  `pre code` reset, so each code block showed a box inside its box. The
  `<code>` of a code block now gets a reset style; inline code is unchanged.
- **mdopen and the MCP server: a launcher killed by a signal says which.**
  An `xdg-open` (or `gio`, `open`) ended by a signal was reported as having
  "exited with status signal". The message now says it was killed and names
  the signal (`was killed by signal 9 (SIGKILL)`).
- **mdopen: `--edit=yes` is told the flag it meant.** A flag given a value
  with `=` (no flag takes one) was compared whole, so `--edit=yes` got only
  "unknown flag". The part before `=` is now compared, and the error says
  "did you mean --edit?".
- **MCP: connecting to the app gives up after half a second.** The server's
  connection to Ashlr MD had no connect timeout, so a port whose listener took
  no more connections held a tool call for the system's own timeout, a minute
  or more. It now waits at most 500 ms, as `mdopen` does, and says it could
  not connect.
- **MCP: a vault search names the Markdown files it cannot read by path.**
  Searching a `vault` on disk passed each path on lossily, so a note in a
  folder whose name is not UTF-8 (or a link to one) named no file and was
  left out without a word. The search's note now says how many such files
  were not searched, names the first few and says to rename them, and a
  `vault` that is itself such a folder is refused, saying why.
- **MCP: a request line has a size limit.** The server read each stdin line
  whole, however long, so a client that sent a huge line (or bytes with no
  newline) grew its memory without bound. A line longer than 64 MiB (room for
  a 16 MiB document escaped several times over) is now read to its end
  without being kept and answered with a JSON-RPC `-32600` error on stdout;
  the requests after it are still served.
- **mdopen and the MCP server: a launcher that cannot start says so.** An
  `xdg-open` (or `gio`, `open`) on the PATH that could not be started, not
  being executable for one, was reported as having "exited with status
  signal", which read as a crash of the launcher. The message now says it
  could not be started, with the system's reason.
- **mdopen: `~/` is the home folder, even quoted.** `mdopen "~/notes.md"`,
  or a script's `FILE="~/notes.md"`, reaches mdopen unexpanded, and it
  looked for a folder named `~` in the working directory ("does not exist").
  A leading `~` (alone or before `/`) is now the home folder, as it is for
  the MCP server's paths; a file that is really there by that name still
  wins, and `~user/` is left as it is.
- **mdopen: a path that resolves to a non-UTF-8 name is refused.** `mdopen
  notes.md`, where `notes.md` links into a folder whose name is not UTF-8,
  handed the app the lossy spelling of the target, a path that names no
  file. mdopen now stops with exit 1 and says the resolved path is not
  UTF-8; the `--hook` mode opens nothing for such a file.
- **MCP: a path that resolves to a non-UTF-8 name is refused, saying so.**
  A `notes.md` link into a folder whose name is not UTF-8 was resolved to
  the lossy spelling of its target, a file that does not exist, so
  `open_file`, `export_text`, `diff_documents` and the other path tools said
  "the file does not exist" of a file that is there. They now refuse it,
  naming the path it resolves to and saying to rename it.
- **An edit that changes nothing does not leave the window unsaved.** Every
  keystroke tells the close guard at once that the window has unsaved edits,
  and only the next change in the document store said otherwise. A
  character typed and deleted before the editor reported it changed nothing
  there, so the window stayed marked unsaved, and a close went through the
  window first. Half a second after the last edit the guard now takes the
  edits and reports what is true.
- **Adding or removing a table column keeps the table's layout.** A column
  added or removed in the WYSIWYG editor saved the whole table re-padded,
  every column to its widest cell, so the change showed as every row of the
  table. The other columns now keep their padding and delimiter cells, and
  only the new column's cells are written.
- **Exports with math carry only the fonts they use.** An HTML or PDF export
  with math put all 20 KaTeX fonts in the page (about 300 KB), most of them
  for symbols the page never shows. It now puts in the faces the read view
  set the math in (a plain formula needs KaTeX's Main and Math faces); the
  others stay links the browser follows only if it needs them. When the
  faces cannot be measured, every font is put in, as before.
- **Email export keeps an element's own style.** The email export added its
  inline style as a second `style` attribute to an element that had one (a
  highlighted code block, raw HTML with a style), and a second `class` to a
  table with a class. Browsers and mail clients read only the first, so the
  code block lost its colours. Both are now merged into the one attribute,
  with the element's own declarations last so they still win.
- **A list item that starts with a callout keeps it.** Editing such an item
  (`- > [!TIP]`, or one that starts with a code block) in the WYSIWYG editor
  saved it as `- <br />` with the callout on the lines under it, as the
  editor gives every item a paragraph first. That empty paragraph is no
  longer written, so the item is saved as it was typed.
- **mdopen's timeout test no longer flakes under load.** It answered 500 ms
  after mdopen's 6 s read timeout, and an mdopen that started its read late
  got the answer in time and failed the test. The fake app now never answers
  and waits for mdopen to hang up.
- **The PDF waits for its fonts.** The print frame was printed 150 ms after
  it loaded, whatever was still loading, so a PDF's math could come out in
  fallback fonts. It now waits for the frame's fonts (up to 3 seconds).
- **An export picked without an extension gets one.** The Linux save dialogs
  do not add the extension, so an export saved as `report` was a file named
  `report` that no app opened as HTML, Word or EPUB. The format's extension
  is now added (`report.html`); as the dialog asked about `report`, not
  `report.html`, a file already there under the new name is not replaced.
- **Math in HTML and PDF exports uses KaTeX's fonts.** The exported page
  inlined KaTeX's stylesheet, whose fonts are links (`fonts/KaTeX_Main-Regular.woff2`)
  that resolved next to the exported file, or in the app for the PDF, where
  no such files are. Every formula was set in fallback fonts, with misdrawn
  roots, brackets and large operators. When the document has math, the
  export now carries the fonts in the page (WOFF2, about 300 KB), so it is
  still one offline file.
- **Exports wait for Mermaid diagrams.** A diagram is drawn once mermaid has
  loaded, and an export taken before then (always, from the palette in Edit
  view, which switches to Read view just before) held an empty block where
  the diagram goes. Exports now wait for diagrams as they do for images, up
  to the same 5 seconds, and a diagram still not drawn is exported as its
  Mermaid source in a code block.
- **A cancelled export is not reported as done.** Cancelling the save dialog
  of an HTML, Word, EPUB, Notion, Slack or email export left the Export
  dialog saying "HTML exported." and closing it, though nothing was written.
  It now stays open with no status.
- **Export failures say why, once.** An export from the command palette that
  failed with an error (not a plain message) toasted only "Export failed",
  without the reason, and a failed write was toasted twice, by the export and
  again by the palette (or by the MCP export, as "MCP export failed"). The
  reason is now always shown, and a failed write is toasted once.
- **Exports from the command palette are named after the document.** "Export
  as HTML/PDF/Word/EPUB" in the palette passed the file name with its
  extension, so the save dialog offered `notes.md.html` and a document
  without a front matter `title` was titled "notes.md". They now strip the
  extension as the Export dialog and the MCP export do (`notes.html`).
- **Closing right after typing asks to save.** The WYSIWYG editor reports an
  edit 200 ms after the last keystroke, and the window told the close guard
  it had unsaved edits only from that report, so closing the window in that
  time closed it without asking and the edit was gone. Every edit now marks
  the window unsaved at once, and a close takes the editor's edits before it
  decides whether to ask.
- **Recreate never writes over a file that came back.** Saving a tab whose
  file was deleted or moved asks before writing it again, and that write went
  ahead whatever was there by then, so a file back in a form the app cannot
  read (not UTF-8, too large, not a regular file) was replaced by the tab's
  text. A recreate is now refused when anything is at the path: a readable
  file is offered in the banner as a change on disk, and an unreadable one is
  refused with the reason ("a file is there again but cannot be read"),
  pointing to Save As.
- **A recovered tab is watched.** Unsaved text reopened for a file that could
  not be opened at launch was never watched, so when the file came back (a
  sync client caught up, a drive was mounted again) the tab still read as
  gone. It is watched as an opened file is: the file coming back clears the
  missing banner and its text is offered against the kept text.
- **A file renamed on disk is followed.** Renaming the open file in another
  app (or `mv` in a terminal) read as the file being deleted: the tab was
  flagged missing and Save offered to recreate the old name. Where the system
  reports both names (Linux, and Windows), the tab now takes the new path and
  name, keeps any unsaved text, and is watched there; a toast says so. On
  macOS, and for a move to another folder, the tab is still flagged missing.
- **A file that cannot be watched is said so.** When watching the open file
  for changes made in other apps failed (its folder gone, the system's watch
  limit reached), the watch of the file shown before was kept and the
  failure was dropped, so changes on disk went unnoticed without a word. The
  old watch is now dropped first, and the window shows "Changes made to ...
  outside Ashlr MD will not be noticed" with the reason.
- **The table wizard inserts a table.** Insert in the WYSIWYG table wizard
  (⌘⇧T outside a table) typed the table's Markdown into the document as
  text, so it showed as a paragraph of pipes and was saved with every pipe
  escaped. It now inserts a real table after the cursor's block (or in
  place of an empty line).
- **A nested list keeps its own marker.** The list marker is one setting for
  the whole edited list, so typing in `- a` with `* b` nested under it saved
  the nested list as `- b`, and a `1)` list nested in a `1.` list became
  `1.`. Each nested list is now written with the marker its source used.
- **An edited callout stays a callout.** Typing in a GitHub callout
  (`> [!NOTE]`, `> [!WARNING] Title`) in the WYSIWYG editor saved its marker
  as `> \[!NOTE]`, so it showed as a plain quote from then on. The marker is
  kept as written.
- **An edited table keeps its layout.** Typing one character in a table cell
  in the WYSIWYG editor re-padded every column of the table to its widest
  cell. Rows whose cells did not change are now kept as written, a changed
  row keeps the padding of its other cells (and of the changed one), and the
  delimiter row (`|:--|--:|`) is kept while the columns and their alignment
  are the same. A table without outer pipes stays without them.
- **An edited indented code block stays indented.** Typing in a code block
  written with four spaces (or a tab) in the WYSIWYG editor saved it as a
  backtick fence. It is written indented as it was, unless a language was
  picked for it.
- **An edited code block keeps its fence and info string.** The WYSIWYG
  editor's code block holds only the language, so typing in a block fenced
  with `~~~` wrote it with backticks, and an info string such as
  ```` ```ts title="a.ts" ```` lost everything after the language. The block's
  own opening and closing fence lines are kept (a changed language replaces
  only the first word), and an indented fence keeps its indentation.
- **What was just typed in the WYSIWYG view is never dropped.** The editor
  reports a change 200 ms after the last keystroke, and drops the report
  when it closes. A change on disk in that time (a sync client, an agent)
  found the tab clean, took the disk's text and reloaded the editor, so the
  typing was lost without a word; a save in that time left it out, and a tab
  or view switch lost it. The editor's text is now taken before any of
  these, so the change on disk is offered in the banner as usual.
- **Two quick changes on disk end on the newer text.** Each change the file
  watcher reports is read again, and the reads run side by side, so for two
  quick saves in another app the first read could answer last: the window
  showed the older text and took it as the file's, so its next save was
  refused as a conflict. Only the last read's answer is used now.
- **Reordering images by dragging survives the next keystroke.** Dragging an
  image onto another in the WYSIWYG view reordered them in the Markdown but
  not in the editor, so the next thing typed put the old order back. The
  editor now shows the new order, as for a table menu edit.
- **A table menu edit survives the next keystroke.** The WYSIWYG table menu
  (insert or delete a row or column, align a column) changed the Markdown
  but not the editor, which kept the old table, so the next thing typed
  anywhere wrote the old table back. The editor now shows the menu's table
  too, and keeps it as the menu wrote it.
- **The WYSIWYG table menu opens in a built app.** The editor's table menu
  (right-click or double-click in a table, ⌘⇧T) and Enter continuing a list
  were wired up in a step that ran before the editor's view was known, found
  none and never listened. Development builds run that step twice, which hid
  it. The view is now known first.
- **A block the editor cannot map no longer rewrites the whole file.** When
  the WYSIWYG editor's blocks did not line up one to one with the file's, any
  edit wrote the whole document the serializer's way. The blocks are now
  matched by kind, and only the region around a block that has no match is
  written anew, out to the nearest matched blocks; the rest is kept byte for
  byte. A one-to-one map whose kinds do not agree is matched the same way,
  instead of being taken as is (which shifted every block after an extra one).
- **An inline `<br>` is kept.** The WYSIWYG editor dropped every `<br>` when
  it read a document (Milkdown's plugin for the `<br />` it writes for an
  empty paragraph took them all), so `a<br>b` showed as `ab` and was saved
  so once its paragraph was edited. Only a `<br />` that is all a paragraph
  or table cell holds is read as empty now; any other stays in the text.
- **An edited block keeps bare links bare.** Editing a paragraph in the
  WYSIWYG view wrote `www.example.com` as
  `[www.example.com](http://www.example.com)` and `https://example.com` as
  `<https://example.com>`. A URL, `www.` address or email address the
  source wrote bare stays bare; one written `<...>` or `[...](...)` stays so.
- **An edited block keeps its character references.** Editing a paragraph
  in the WYSIWYG view wrote `&nbsp;`, `&copy;`, `&#169;` and the like as the
  characters they stand for, and `&lt;tag&gt;` as `\<tag>`. Each is now
  written as the block's source wrote it: one for one while the block holds
  as many of that character, else the one way the source wrote it.
- **An edited block keeps trailing-space line breaks.** A hard break written
  as two trailing spaces became a backslash when its paragraph (or list item,
  or quote) was edited in the WYSIWYG view. A block that wrote its breaks
  with spaces keeps writing them so; one that used backslashes keeps those.
- **An edited setext heading stays setext.** Typing in an underlined
  (`===` or `---`) heading in the WYSIWYG view wrote it as a `#` heading. It
  now stays underlined, with its underline as it was, and a `## Title ##`
  heading keeps its closing `##`.
- **An edited list keeps its markers and numbering.** Typing in a list in the
  WYSIWYG view wrote it Milkdown's way: `-` and `+` bullets became `*`, `1)`
  became `1.`, and a list numbered `1.` `1.` `1.` was renumbered `1.` `2.`
  `3.`. An edited block is now written in the style its source used, so the
  list keeps its marker, its delimiter and its numbering.
- **An edit before a last list, table or rule leaves that block alone.** On
  the first edit the WYSIWYG editor adds an empty paragraph after a last
  block that is not a paragraph, so every edit looked like a change at the
  end of the file and that block was rewritten: a `- - -` rule became `***`,
  `+` bullets became `*`, a table was re-padded. The added paragraph is no
  longer taken for a change.
- **Unsaved text for a file that cannot be opened is kept.** At launch, the
  text kept for a file that was deleted, moved or cannot be read was reported
  ("could not be restored") and dropped. It now opens in a tab of its own,
  unsaved and flagged as gone, so the banner offers Save As (or Recreate),
  closing the tab asks first, and it is kept for the next launch too. If the
  file turns up again, a save is refused as a change on disk, so the banner
  offers both versions instead of writing over it.
- **The app's `/export` without `overwrite` no longer replaces a file.** A
  request with an `outputPath` and no `overwrite` flag (a caller written
  before the flag existed) replaced a file already there. It is now refused
  in the write itself, as with `"overwrite": false`; `"overwrite": true`
  still replaces it. mdopener-mcp always sends the flag, so the MCP
  `export` tool is unchanged.
- **Rich copies name the document's language.** Both rich copy commands said
  `<html lang="en">` (or no language at all), whatever the document's language.
  They now use the front matter's `lang` the way exports do: a language tag in
  the BCP 47 shape (`en_US` reads as `en-US`), else `en`.
- **Editing in the WYSIWYG view no longer rewrites the whole file.** One
  typed character wrote every block back the way the editor spells it:
  setext headings became `#` headings, `-` and `+` bullets became `*` and
  tight lists loose, reference links became inline and their definitions
  were dropped, indented code and `~~~` fences became backtick fences (an
  info string lost its `title="..."`), tables were re-padded, entities were
  decoded, trailing-space line breaks became backslashes, the blank line
  after the front matter went away and a final newline was added. Now only
  the blocks you edit are written; every other block, and the text between
  them, is kept byte for byte. In an edited block a tight bullet list stays
  tight and an empty table cell stays empty (it was written `<br />`).
- **Exports name the document's language.** Every exported page said
  `<html lang="en">`, so a screen reader read a French document with English
  rules. The front matter's `lang` (`lang: fr-CA`) now names it, in HTML
  exports, export profiles, DOCX and EPUB, when it is a language tag in the
  BCP 47 shape (`en_US` reads as `en-US`); anything else, or none, is `en`.
- **Copy as rich text waits for images still loading.** A local image or
  embed shows "Loading…" until Rust has read it, and a rich copy taken then
  carried its name instead of the image. Both rich copy commands now wait
  for them as the exports do (at most five seconds).
- **MCP: `export` without `overwrite` cannot replace a file.** It checked
  for a file at `output_path` and then the app wrote the export, so a file
  put there in between was replaced. The app is now told not to replace
  one, and writes the export to a temp file published with a hard link
  (created with `O_EXCL` where links are not supported), which fails when
  anything is at the path. With `overwrite: true` nothing changes.
- **MCP: `edit_canvas` is listed as destructive.** It writes the canvas
  file back in place (`save` defaults to true) and can remove nodes and
  edges, but said `destructiveHint: false`, so a client that confirms
  destructive tools let it rewrite a canvas unasked. It now says `true`, is
  in the destructive tier, and is listed with the destructive tools after
  `export_metadata` (docs/AGENTS.md moves its row).
- **Opening the outline or agent activity moves focus into it.** Opened
  from a shortcut, either panel left focus where it was, so a keyboard user
  had to find it. Focus now goes to the current heading's entry (else the
  first, else the close button) in the outline, and to the open file's
  entry (else the newest, else "Watch a folder…") in agent activity. On
  close it goes back, as before.
- **Command palette groups are real groups.** The group headings were plain
  elements among the palette's options, which a list box may not hold. Each
  group's commands now sit in a group labelled by its heading, so a screen
  reader names the group once as you move into it.
- **The tab bar follows the ARIA tabs pattern.** Each tab's close button sat
  inside the tab list, which may hold tabs only, and no tab named the
  document area it shows. The row wrappers are now presentational, the
  close buttons are a pointer affordance hidden from screen readers and out
  of the Tab order (Delete on a tab closes it, and so does ⌘W), and the
  active tab controls the document area, which is a tab panel labelled by
  it while tabs are shown.
- **Restoring a session: at most 20 tabs, Recents untouched, gone files
  named.** A session of hundreds of tabs reopened every one, and each
  reopened tab was pushed to the top of Recents, so Recents ended up in tab
  order. Now the first 20 tabs reopen (the active tab always among them, and
  the message says how many stayed closed), and Recents keep their order. A
  saved tab whose file was moved or deleted since was dropped without a
  word; the launch message now names it. A failed existence check no longer
  clears the saved session.
- **Unreadable settings are kept, not overwritten.** Settings that were not
  readable JSON were replaced by the defaults on the next change, without a
  word. A copy is now kept first (`mdopener-settings.bak` in the app's
  storage, or a timestamped `.bak-` key when an earlier copy is there), and
  a message says so once.
- **Settings from a newer version keep their version.** Settings written by
  a newer Ashlr MD were saved back as version 8 by this one, so the newer
  app, run again, re-ran its migrations over them. The higher version is now
  kept (with the keys this version does not know, as before).
- **Unsaved text survives a crash or forced quit.** The text of every tab
  with unsaved edits is now kept in the app's local storage half a second
  after the last change, and put back in its tab (still unsaved) on the next
  launch, with one message saying which. A quit the close prompt cannot
  catch (⌘Q on macOS), a crash, or an update's relaunch no longer loses it.
  When the file changed on disk meanwhile, the external-change banner offers
  the disk version. Close Without Saving forgets the copy. A document over
  a million characters (or past three million in all) is not kept, and text
  whose file can no longer be opened is reported, not restored.
- **Closing the window asks about unsaved edits.** Closing the window (its
  close button, Alt+F4, Close Window) with unsaved edits in any tab dropped
  them without a word. It now asks: Save All, Close Without Saving, or
  Cancel. A failed or cancelled save keeps the window open. The close is
  held in Rust, not by a page listener, so it cannot leave a window that
  will not close: a window that does not answer within 1.5 seconds, or
  whose prompt fails, closes as before.
- **Focus comes back after a review.** An agent's review request takes
  keyboard focus so it is noticed; once approved, sent back, dismissed or
  timed out, the panel was gone and focus with it. Focus now returns to
  where you were, the editor for instance.
- **Reduced motion stops the scroll animations too.** With "Reduce motion"
  set in the system, the app's animations were calmed, but jumping to a
  heading from the outline or a link, to a find match, to a review finding,
  and the AI chat's scroll to the newest message still animated: a smooth
  scroll asked for in code is not changed by the stylesheet. They now jump.
- **The tab bar answers the arrow keys.** It is announced as a set of tabs,
  but every tab was its own Tab stop and the arrow keys did nothing. Now
  only the active tab is a Tab stop, and Left, Right, Home and End move to
  and open the previous, next, first and last document. A tab's unsaved
  dot, and an agent-activity file's "new" dot, are now read by screen
  readers (their labels sat on plain spans, which are not read).
- **Closing a side panel gives focus back.** File search, the outline and
  agent activity stay in the page while closed, unreachable, so closing one
  from its close button or with Escape left keyboard focus on nothing. Focus
  now returns to where it was when the panel opened. The file search field
  also has a label for screen readers (it had only a placeholder).
- **The command palette gives focus back when it closes.** It meant to
  return focus to what had it, but remembered its own search field (already
  focused by then), so closing it left focus on nothing and a keyboard user
  had to find their place again; Tab also left the palette for the app
  behind it. Focus now returns to where it was, Tab stays inside, and the
  search field is announced as a combobox with its list of commands.
- **Restoring the last session skips a file it cannot open.** A saved tab
  whose file was there but could not be read (not text, too large) had its
  view mode applied to the tab before it, was counted in "Reopened n
  documents", and left its error in place of the restored document. It is
  now skipped. A damaged saved session (not a list, entries without a path,
  a path saved twice, an unknown view mode) is read safely instead of
  stopping the restore.
- **A damaged settings file no longer breaks the app.** Settings were
  loaded as stored, whatever their type, so a hand edit, a damaged file or
  a newer version that changed a value put a `null` linter config (the
  linter threw on every document), a text font size or an unknown theme
  into the app. Each setting is now checked when loaded: a value of the
  wrong type keeps its default, a setting missing from the file (such as
  "Load remote images") takes its default, malformed templates and snippets
  are dropped, and keys from a newer version are kept for it.
- **Save As onto a file open in another tab leaves one tab.** Both tabs
  stayed open for the same file, and the other one showed the text the save
  had just replaced, so its next save wrote that back. The other tab now
  closes once the save is done; when it has unsaved changes of its own (or
  holds the only copy of a file gone from disk), Save As asks before
  replacing it, and nothing is written if you say no.
- **An export waits for images still loading.** A local image is read from
  disk after the page renders and shows "Loading name…" until then, so an
  export (or a copy as rich text) taken meanwhile held that text instead
  of the image. Exports now wait up to 5 s for the read view's images and
  embeds, and one still loading after that is exported as its name, never
  as the placeholder.
- **The Slack export is Slack text.** The Slack profile saved a whole HTML
  page (styles and markup) into its `.txt`, which pasted into Slack as
  code. It now writes Slack's own formatting: `*bold*`, `_italic_`,
  `~strike~`, `` `code` ``, fenced code blocks, `> quotes`, `<url|text>`
  links, bullet and numbered lists, headings as bold lines and tables as
  rows, with images as their alt text.
- **Exports carry the front matter's title and author.** An EPUB was titled
  by its file name with an empty author, and the HTML, PDF, DOCX and
  profile exports were titled by the file name too. The front matter's
  `title` and `author` (a list of authors joined with commas) now name the
  book, the page's `<title>` and the DOCX properties; the suggested file
  name is still the file's.
- **MCP `export` no longer overwrites a file unasked.** With `output_path`
  it replaced whatever file was there while it was listed with
  `destructiveHint: false`. An existing file is now refused unless the call
  passes the new `overwrite: true` (default `false`, as `save` defaults to
  `false` on the edit tools), and the tool is listed as destructive, after
  the read-only and targeted tools.
- **An export never writes through a symbolic link.** An HTML (or Notion,
  Slack or email) export chosen in the dialog was saved like a document,
  into the file a link points to, so exporting over a `report.html` linked
  to `~/.bashrc` replaced the shell profile; a DOCX or EPUB replaced the
  link with a file. Every export is now written by one command that refuses
  a symbolic link, as the agent's headless export already did, and the
  error says to export to the file it points to or to another name.
- **Large DOCX and EPUB exports are written without a JSON detour.** Their
  bytes crossed to the app as a JSON array of numbers, about 3.6 bytes of
  JSON for each byte of the file: a 32 MiB EPUB became 114 MiB of JSON, and
  building and parsing it took about 2.4 s (1.3 s and 1 s; 8 MiB: 0.6 s).
  The bytes are now the request's raw body (about 25 ms for 32 MiB), with
  the path in a percent-encoded header.
- **Exports never write into an Obsidian config folder.** A Markdown save
  refused `.obsidian/`, but a DOCX or EPUB export (`write_file_bytes`) did
  not, so an export saved as `.obsidian/app.json` replaced the vault's
  settings. Both now share one guard, which also follows a folder that
  links to `.obsidian`.
- **EPUB export works with images.** The EPUB library fetches every image,
  and the app's content policy refuses a `data:` URL (how a local image is
  shown) and the web alike, so a document with any image failed to export;
  a `data:` image also went in with no media type. Images are now handed to
  it from memory, and a web image becomes a link to it.
- **Export file names are always valid.** The suggested name cut long titles
  by UTF-16 units, which could split an emoji into half a surrogate pair that
  the save dialog rejects, and kept leading dots (a hidden `.env.html`),
  trailing dots, control characters and Windows device names such as `nul`.
  It now cuts by whole characters, drops those, and turns a tab into a
  separator.
- **`export_text` reads tables by GFM's rules.** It took any line with a `|`
  over a delimiter-like line as a table, and ended a table at the first line
  without a `|`. A table now starts only at a header over a delimiter row with
  as many cells (`a | b` over `| - |` is text, as on the page; `a` over `:-:`
  is a table), and a body row without a pipe goes on with it until a blank
  line or another block (a list, heading, quote, rule or fence).
- **`export_text` decodes every HTML named character reference.** It knew about
  140 common names, so the rest of HTML's 2125 (`&aring;`, `&eacute;`,
  `&ccedil;`, `&NoBreak;`, `&Cconint;`) stayed as written in the plain text
  while the page showed the character. The full table adds about 22 KiB to the
  `mdopener-mcp` release binary.
- **Save As keeps one tab per file.** After Save As, the tab was found by the
  path as the dialog gave it, so opening the new file by another path (through
  a symbolic link, or in other case on a disk that ignores case) opened it in a
  second tab, and each tab's saves overwrote the other's. The tab now goes by
  the new file's real path, as an opened file's does.
- **Closing the tab of a deleted file asks first.** A tab whose file was
  deleted or moved outside the app, with no edits, closed without a word, and
  its text (then only in the tab) was gone. Closing it now asks: Save As (then
  close), Close Without Saving, or Cancel.
- **Relative images show in the WYSIWYG editor.** The editor used an image's
  path as written as its source, which loads from the app's own address, so a
  pasted `![](assets/x.png)` showed broken while editing. Images now load as in
  the read view: relative to the document, read from disk. The Markdown keeps
  the path as written.
- **Wikilinks to a heading or a block scroll there.** `[[note#^abc]]` opened
  the note at its top: a block's `^abc` id had no anchor (and showed as text on
  the block). Block ids now anchor their paragraph, list item, or the table or
  quote a lone `^abc` line follows, and are not shown. A heading fragment is
  percent-decoded and an Obsidian subheading path (`[[note#Parent#Child]]`)
  scrolls to its last heading.
- **A link's hover preview and a click open the same file.** The preview looked
  every link up as a wikilink (anywhere in the vault) while a click opened the
  path relative to the document, so the two could name different files, and a
  bare `[x](Note)` with no extension previewed a note that a click refused with
  a toast. Both now resolve by one rule: a path with a Markdown extension is that
  file relative to the document, and a bare name is found as a wikilink is (this
  folder first, then the vault). A link a click would not follow shows no preview.
- **An embedded note's links and images resolve from its own file.** In
  `![[sub/note]]`, the note's `![](img.png)`, `[x](other.md)` and `[[link]]`
  were resolved from the document holding the embed, so its images were missing
  and its links pointed into the wrong folder. They now resolve from the
  embedded file, as they do when it is opened.
- **`[[wikilinks]]` in the read view are links again.** The HTML sanitizer's
  rule for links allows only GitHub's footnote class, which replaced the
  general class rule, so the `wikilink` class was stripped: `[[note]]` rendered
  as a link with no destination and a click only said so. Wikilinks render as
  wikilinks again (resolved, broken ones marked, a click opens the note).
- **Wikilinks to plain-text attachments resolve.** `[[notes.txt]]` and
  `![[data.csv]]` were refused like `config` or `.json` files, so they showed
  as broken links. `.txt`, `.text`, `.csv` and `.tsv` now resolve, inside the
  vault and through no hidden folder as before, and an embed shows the text as
  written rather than reading it as Markdown.
- Hovering a read-view link whose path is percent-encoded (`[x](My%20Note.md)`) now previews the note; the preview looked the path up as written and found nothing.
- **A heading's copied link opens at that heading.** The "copy link" button
  on a heading copies `mdopener://open?path=…&heading=<slug>`, but the link
  handler ignored `heading`, so the link opened the document at its top. The
  heading now waits for the window like the link's `mode` does, and the
  window scrolls to it once the document has opened.
- **Links and images in the read view work.** A `[x](#heading)` link did
  nothing (every link opens in a new context, which only web and mail links
  had a handler for), a link to another Markdown file did nothing, or on
  Windows opened the app's own origin in the browser, and a Markdown image
  with a relative path (`![](assets/x.png)`, which pasting an image inserts)
  never showed. A `#fragment` now scrolls to the heading (its id, or the slug
  of its text), a link to a Markdown document opens it in a tab (relative to
  the document, percent-decoded, `#heading` included), and a local image is
  read through Rust as `![[x.png]]` embeds are, with spaces and non-ASCII
  names, and a "Missing image" note when it is not there. Links to other
  schemes, to files that are no Markdown, or into hidden folders
  (`../.ssh/x`) are not followed, and a toast says why.
- **`[[note\|alias]]` links to `note`.** In a table cell an alias's pipe is
  written `\|`; mdopener-mcp's `export_metadata` and the app's
  "Wikilink targets exist" lint read the target as `note\`, so a link that
  resolves was listed (and flagged) as a missing note.
- **A line indented four columns after a table is code, in the app and for
  agents.** mdast reads `| a |`, `| - |`, then `    | c |` as a table and a
  code block. The app's prose masking (`maskInlineCode`, which lint reads
  links from) left those lines as text, so a `[[link]]` or URL in that code
  was read, while mdopener-mcp's link and image counts dropped them; and
  `export_text` read them trimmed, as a table row (`c`) or as Markdown. Both
  now treat them as code: the app masks them whole, `export_text` keeps them
  as written, and an indented header or delimiter row starts no table.
- **Agents' plain text decodes character references and keeps unpaired
  emphasis markers.** mdopener-mcp's inline stripping (export text, titles,
  headings) kept `&amp;`, `&#123;` and `&#x1F600;` as written where the page
  shows `&`, `{` and 😀, and dropped every `*` and `_` run that was not
  between spaces or inside a word, so `*note` lost its star. References are
  now decoded as CommonMark does (numeric ones, and a table of the common
  named ones; an unknown name stays as written), and markers are dropped only
  when they pair as emphasis by micromark's rules (flanking, `_` in words,
  the rule of three), fuzzed against remark-parse.
- **A lone CR ends a line for the Rust Markdown scanners too.** The shared
  line scanner (`markdown_lines.rs`: front matter, fences, headings, tasks,
  wikilinks, export text, semantic-search chunks) split lines at LF only, so
  an old Mac file (CR line breaks) was one line: its code was read as
  Markdown and its front matter was missed, while the editor and the Outline
  saw many lines. It now uses the shared `line_breaks` rule, as search
  already did, and so do the search chunker and `frontmatter_lines`.
- **An agent's save is reported as saved when the user switches tabs during
  it.** `save: true` on an edit read its outcome back from the active tab, so
  switching tabs while the file was written told the agent the save failed
  (and a retry applied the edit again). The save now names the edited tab and
  reports its own result.
- **One file opened by two paths is one tab.** Tabs were matched by the path
  as given, so a note opened through a symbolic link, with `..`, in the other
  Unicode form or in other case opened in a second tab, and each tab's save
  overwrote the other's. The read now names the file's canonical path and
  whether its filesystem ignores case (probed) and Unicode normalization
  (macOS), and opening a file already open switches to its tab. Case and
  normalization are folded only where the filesystem folds them. The tab keeps
  the path it was opened by, so its relative links and vault are unchanged.
- **A file deleted or moved while open is shown, and is not silently
  recreated.** The window showed nothing when the open file was deleted or
  moved by another app, and the next save wrote it back at its old place. The
  tab is now flagged and a banner says so, keeping the text, with Save As… and
  Recreate…. A save asks before writing the file again; an agent's save
  (`save: true`) is refused instead of asking. A file that comes back clears
  the flag. "Save As…" is also in the command palette.
- **A save no longer overwrites a change made on disk since the file was
  read.** The window sent its text and the file was replaced, whatever was
  there: a change another app (or a sync client) made while the tab was open,
  before the watcher reported it, was lost. A save now carries the version of
  the read its text is based on, and when the file on disk no longer matches
  it nothing is written: the change is offered in the banner ("Keep mine",
  then save again, replaces it). Touching the file without changing it is not
  a change. After the rename the folder is synced on Unix, so a crash just
  after a save cannot bring the old file back, and the owner and group are
  kept where the process may set them, as the mode already was. Hard links,
  extended attributes, ACLs and Finder tags are not carried over to the new
  file (documented at `write_atomic`).
- **A read-only file is no longer overwritten.** A save (or an export over
  an existing file) wrote a new file and renamed it into place, which needs
  only the folder to be writable, so a note with no write permission
  (`chmod 444`) was replaced with the new text. The save now fails with
  "it is read-only" and leaves the file as it was.
- **Changes made to a background tab's file are noticed, and unchanged files
  raise no conflict.** Only the active tab's file is watched, and switching
  back to a tab did not read its file again, so a change another app or an
  agent made meanwhile was never shown and the next save wrote over it. A tab
  now re-reads its file when it becomes active, reloading it when it has no
  edits and offering the change when it has. A watcher event that re-read
  the same text (a `touch`, a permission change) flagged a conflict while
  the document had edits; it is now ignored, and a change undone on disk
  takes its banner away.
- **Edits made while a save is writing stay unsaved.** A save marked the
  document clean when the write finished, even if more was typed during it,
  so closing the tab then dropped those edits without asking. And when the
  tab was switched during the write, the tab switched to took the saved
  tab's text as its baseline and lost its unsaved mark. A finished save now
  marks only the tab it wrote, and only as clean as what it wrote.
- **Edits to a symlinked note's real file are noticed.** The window watched
  only the folder of the path it opened, so when that path was a link (or
  ran through a linked folder, as `/tmp` does on macOS, where events name
  the real path) a change made by another app or an agent made no event: the
  window kept the old text, and its next save wrote over the change. The
  real file's folder is now watched too.
- **Saving a symlinked note writes the note it links to.** The window reads
  a document through a symbolic link, but a save renamed the new text over
  the link, so the real file (in a dotfiles repository or a synced folder)
  kept its old text and the link became a separate copy. A save now writes
  the file the link points to (through every link), keeping its permissions,
  and refuses a link to a missing file instead of replacing it. The
  `.obsidian/` guard judges the linked file. "Apply hunk" still writes only
  the path it checked.
- **Plain text drops backslash escapes.** `strip_markdown` (the sidecar's
  plain-text export and its word counts) kept the backslash of an escape, so
  `\*not bold\*` read `\*not bold\*` and `Cost \$5` read `Cost \$5`, where
  the page shows `*not bold*` and `Cost $5`. An escape is now the character
  it escapes and no markup, a backslash before a line break (a hard break)
  is dropped, and an escaped `]` no longer ends a link's text.
- **A backtick or `$` in a bare URL no longer starts a code span.** GFM
  reads `https://x.org/` followed by a backtick, or `www.x.org/$a$`, as part of a literal
  autolink, but the lint rules, the Outline's slugs and the sidecar's link and
  image counts paired that backtick with a later one and took the text
  between for code, hiding a `[[link]]` after the URL. Literal autolinks
  (`www.` and `http(s)://`, by remark-gfm's rules for where they start and
  which trailing punctuation they leave out) now hold no span, in the app and
  the sidecar, and a URL's `_` is no emphasis in a heading's slug. A line's
  blockquote marker is no longer read as text before it (`>www.x.org`).
- **A code span no longer runs across GFM table cells.** remark-gfm reads
  each table cell as its own inline text, so `` | `a | b` | `` shows two
  backticks as text. The lint rules (the Outline's `maskInlineCode`) and the
  sidecar's link and image counts (`prose_chars`) read the text between them,
  or a backtick in the next row, as code, so a `[[link]]` or `![[image]]` in
  a table could go uncounted and a lint rule skipped text the page shows.
  A table (a header row with as many cells as the delimiter row after it,
  not on a lazy line) is now read cell by cell. Fuzzed against mdast.
- **Outline links reach headings with HTML, entities, escapes or spacing.**
  The Outline took a heading's slug from text with rough patterns, so it
  differed from the page's id for `# a  b` (`a--b` on the page, `a-b` in the
  Outline), `# Fish &amp; Chips`, `# \*x\*`, `# <b>Bold</b>`, `# snake_case`
  (`_` inside a word is no emphasis), a tab, an image (no text on the page),
  a reference link, and the read view's `%%comments%%`, `==highlights==` and
  `[[wikilinks]]`; clicking such an entry did not scroll. The heading text is
  now read as remark reads it (micromark's emphasis, strikethrough and link
  rules, the document's reference definitions, decoded escapes and character
  references, raw HTML dropped), and every heading, an empty one too, takes
  a slug as rehype-slug gives one. Fuzzed against the read view's pipeline.
- **`stream_edit` previews of a CRLF document have no stray `\r`.** Each
  line of the preview diff ended in the `\r` of its CRLF line break, which
  agents and terminals showed as `^M` or a carriage return over the line. A
  diff line is now its line without the line break; the edit itself still
  writes CRLF.
- **A lone CR is a line break in search, diffs and edit previews.** A file
  with old Mac line breaks (`\r` alone) was one line to the search panel,
  the MCP `search_vault` grep and its snippets, `diff_documents` and the
  `stream_edit` preview, while the editor showed many, so every match was on
  line 1 and a one-line change replaced the whole file. `\r`, `\n` and
  `\r\n` now each end one line, as CommonMark and the editor read them, in
  the app and the sidecar alike.
- **`replace_document` keeps a CRLF document's line breaks and its byte order
  mark.** An agent writes the whole text with LF and no mark, so replacing a
  CRLF file (`replace_document` or `set_content`) changed every line of it on
  save and dropped its BOM. The new text now takes CRLF line breaks when the
  open document uses CRLF throughout and the text has no `\r` of its own, and
  the open document's BOM when it has none. Text with its own line breaks, and
  a mixed or LF document, are written as given.
- **A byte order mark no longer hides a document's first line.** A file
  saved with a UTF-8 BOM (Notepad saves one) kept it before its first line,
  so a `# Title` there was missing from the Outline, front matter after it
  was read as Markdown by the Outline, the lint rules, the task checkboxes and
  the visual editor, and a visual edit saved the file without its BOM (the
  editor drops it). The mark is now read as no text, and the visual editor
  keeps it.
- **Agent edits match line breaks either way.** `edit_document`,
  `stream_edit` and `stream_edit_apply` needed `find` to match a CRLF
  document's `\r\n`s exactly, so an agent's LF `find` was "not found" there
  (the docs said so), and an LF `replace` added LF lines to a CRLF file. A
  line break in `find` now matches LF or CRLF, everything else still matches
  exactly, and `replace` is written in the line breaks of the line it
  starts on, so CRLF and mixed files keep theirs.
- **Indented code counts as code when a document is classified.** The
  document type the AI sidebar hints at measured code by fenced blocks only,
  so a runbook of indented commands read as prose. Indented code now counts
  too.
- **`no-consecutive-blank-lines` keeps indented code whole.** Blank lines
  between two parts of an indented code block belong to the code, but the
  rule flagged them and its fix collapsed them, changing the code. They are
  now read as code, as micromark reads them.
- **Snippet completion reads only up to the cursor.** The check that keeps
  snippets out of code read the whole document on every keystroke. It now
  reads up to the end of the cursor's line, with the same answers (front
  matter that closes after the cursor is still front matter).
- **A new table row has as many cells as its row.** Typing `|` at the end of
  a table row in the source editor split the row on every `|`, so a cell
  holding an escaped `\|` gave the new row one cell more. Cells are now read
  as GFM reads them.
- **`export_text` reads inline Markdown per paragraph.** It read a line at a
  time, so a code span, inline math or a link over two lines of a paragraph
  kept its backticks or brackets, and the `*` and `_` in that code were taken
  off as emphasis. A paragraph's lines are now read together.
- **Inline math is read as the page renders it.** The read view renders `$x$`
  and `$$x$$` with remark-math, but the Outline, the lint rules,
  `export_text` and `export_metadata` read the formula as Markdown. A
  heading's slug missed the KaTeX text the page takes it from (`# Energy
  $E=mc^2$` linked to `energy-emc2`, not `energy-emc2emc2emc2`), `$a*b*c$`
  lost its `*`s, and a `[x](#)`, `![](a.png)` or `[[link]]` in a formula was
  linted, counted or reordered. Inline math is now read as micromark reads
  it, by the rule of code spans, and an escaped `$`, a run never closed and
  a `$` in a link's destination are text. Code spans are read the same way,
  within one paragraph: a backtick used to pair with one paragraphs later.
- **Enter on an empty list item in the visual editor leaves a blank line.**
  Enter after a `- ` typed as text replaced the line, from the position before
  its block, with a newline character, so the line kept a literal line break
  in its text. Only the marker is now deleted.
- **The visual editor's table menu edits the table under the cursor.** It read
  the cursor's ProseMirror position as an offset into the Markdown, though a
  position counts node boundaries, so after a few lines of text the menu,
  `⌘⇧T` and the cell toolbar found another table, or none. The table is now
  found by its index among the document's tables.
- **The visual editor keeps a CRLF file's line breaks.** It writes Markdown
  with LF, so a CRLF file edited there was saved with CRLF front matter and an
  LF body, and every line of the body showed as changed. The body now keeps
  the file's CRLF line breaks.
- **Diff hunks apply to CRLF documents.** An agent's diff hunk is matched by
  its lines joined with LF, so Apply on a hunk in a CRLF document always said
  the patch was not found. Its lines now take the document's line breaks.
  `applyHunkToContent` also read `$$`, `$&` and `` $` `` in the replacement as
  `String.replace` patterns, so `$$` math in a hunk became `$`.
- **Lint fixes leave code and line breaks alone.** `invalid-link-target` and
  `missing-alt-text` (both on by default) read the raw document, so a
  `[x](#)` or `![](a.png)` in a code sample was flagged and its fix rewrote
  the code. The blank-line fix collapsed every run of line breaks in the
  document, in code blocks too, and none of a CRLF file's. Trailing spaces
  before a CRLF were missed, and their fix took a code line's spaces off.
  The front matter fix added LF lines to a CRLF file. Each rule now reads
  code, front matter and code spans by the Outline's rule and fixes only
  what it flags, in the document's line breaks.
- **Agent edit sections read code and front matter by the page's rule.** The
  section an agent edit lands in (front matter, code or prose, which decides
  the side that wins a conflict) toggled code on every line starting with
  three backticks or tildes and ended front matter at any later line starting
  with `---`, so a ```` ```` ```` block holding ```` ``` ````, a `~~~` line
  in a backtick block or a `----` line in front matter misread the rest of
  the document. It now reads lines by the Outline's rule.
- **Dragging an image moves the image dropped.** The visual editor matches
  the images it renders to the image references in the Markdown by their
  order, but it counted references in code blocks, code spans, indented code
  and HTML blocks, which render no image. A drag after one of them moved the
  wrong image and could rewrite the code sample. A CRLF document got LF line
  breaks where the image was moved to. References are now read as the page
  reads them.
- **Enter in a code block adds no list marker.** In the visual editor, list
  continuation read the text of a code block from its start, so Enter in a
  code block whose first line was `- a` or `1. x` inserted `- ` or `2. ` into
  the code. It now reads only the cursor's line, and never in a code block.
- **Source editor snippets and table rows read code blocks as the page does.**
  The source editor took any later fence of the same character as the end of
  a code block, so a ```` ```` ```` block holding ```` ``` ```` or a
  ```` ```js ```` line ended it early, and an indented or quoted fence opened
  none: snippet suggestions showed in that code. Typing `|` at the end of a
  `| a |` line in a code block inserted a table row there. Both now read
  fences by the Outline's rule, `$$` math blocks included.
- **Table edits keep the lines around the table.** An edit from the table menu
  (add or delete a row or column, alignment) took the line break after the
  table and wrote the table back without one, so the next line joined the
  table's last row and a blank line after the table was lost. A table in a
  CRLF file came back with LF line breaks. A table was any line before a
  `---` line, so front matter, a setext heading, a thematic break or a
  `--- | ---` line in a code block was read as a table and rewritten, and an
  escaped pipe (`\|`) split a cell. Tables are now read by the page's rules.
- **`$$` math blocks are read as the page renders them.** The page renders a
  `$$` block with remark-math, but every line reader (the Outline, task
  checkboxes, word count, `export_metadata` headings, `export_text`) read its
  lines as Markdown, so a `# x` in TeX was a heading, `- [ ] x` a task, and
  `export_text` took the `*` and `_` out of the TeX. A math block is now read
  as fenced code is, in blockquotes and list items too; `$$x$$` on one line
  stays inline math. The classifier does not count its lines as code.
- **`export_text` reads code spans by their backtick runs.** A code span
  closed at any run of as many backticks, also part of a longer run, and an
  unclosed run's later backticks opened a new span, so ``` `` b`c ``` read
  `` ` bc ``. A span now closes only at a run of exactly as many backticks,
  an unclosed run is text, and the one space each side of padded code is
  taken off, as CommonMark reads them.
- **`export_text` and `export_metadata` read no wikilink across inline HTML.**
  A `[[...]]` holding a tag, an autolink or a code span (`[[a<b>c]]`) was
  read as a link across it, so `export_text` read `a<b>c` and
  `export_metadata` listed it, although the page reads wikilinks only in its
  text and shows `[[ac]]`. It is now text around them, as on the page.
- **Block embeds find a `^id` only in text.** A partial embed
  (`![[note#^id]]`) took the first line ending with ` ^id`, also in front
  matter or in fenced or indented code, and its block then ran back over the
  fence above it. It now reads lines by the Outline's rule, and a block ends
  at a line that is not text.
- **The broken-wikilink lint skips code spans.** `wikilink-targets-exist`
  reported a `[[link]]` in a code span (`` `[[x]]` ``) or in indented code,
  which the page shows as code and `export_metadata` leaves out. It now reads
  links where `export_metadata` does.
- **Indented code is code to the app's Markdown readers.** The app's line rule
  (`markdownLines`) marked indented code as text, unlike mdopener-mcp's, so
  the status bar's word count counted its words, `no-bare-urls` flagged a URL
  in it, and every other reader of text lines read Markdown in it. It now has
  its own kind, which those readers skip as they skip fenced code.
- **An underline after link reference definitions starts a paragraph.** The
  line rule of the Outline, the headings and `export_text` read an `===`, `--`
  or `- ` line right after a paragraph of only definitions (`[a]: /u`) as a
  setext underline, although definitions leave no paragraph to make a heading
  of. So a `</u>` line after it opened an HTML block that hid the `# Title`
  below it, and an underline after `[a]: /u` and `Title` took the
  definition's text into the heading's slug. Both sides now read definitions
  as micromark does.
- **`export_metadata` reads no wikilinks or images in code.** Its wikilinks and
  image count were read on every line outside fenced code, so a `[[link]]` or an
  `![image](u)` in indented code or in a code span (`` `[[x]]` ``) was counted,
  although the page shows it as code. They are now left out.
- **The document-kind classifier reads no structure in code.** Its heading
  patterns and numbered steps were matched on the whole text, so a code sample
  listing `## Rollback` or `1. step` lines scored as the document's own and could
  make a note a runbook. Its code density toggled on lines starting with three
  backticks, so `~~~` blocks and quoted fences were not code, and its front
  matter hint was missed when a delimiter had spaces after it. It now reads lines
  by the rule of the Outline and the task checkboxes.
- **Spec and review renderers read headings and list items as the page does.**
  Their section headings were matched on raw lines, so a `# comment` in a code
  block ended a spec section (or became the title) and a `## Notes` line in one
  opened a review section; a review's changed files were any `- x` or `1. x`
  line, in code too, and not a quoted item. Front matter was opened by any
  trimmed `---` first line, also an unclosed one, which hid the document. They
  now read lines, list items and front matter by the rules of the runbook fix.
- **Semantic search chunks begin only at headings.** The index cut a document
  into chunks at every line starting with `#`, so the `# comment` lines of a code
  block (and `#tag` lines) cut it into pieces too small to keep, and that code
  was left out of the index. A chunk now begins only at an ATX heading, read by
  the line rule of the Outline.
- **The status bar's word count reads code and containers as the page does.**
  A fence was any line starting with three backticks or tildes, at any
  indentation, closed by any later one of the same character, so a ```` ```` ````
  block holding a ```` ``` ```` line ended early and its code was counted, and a
  quoted fence (`> ````) was counted as text. List and blockquote markers, a
  heading's `#`s, setext underlines and thematic breaks counted as words. The
  count now reads lines by the rule of the Outline and the task checkboxes.
- **Runbook prerequisites and steps follow the page's list rule.** Plain
  prerequisites (`- x`, `1. x`) and ordered steps were matched on raw lines, so
  a `- x` or `1. x` line in fenced or indented code was one, `-x` (no list item)
  was a bullet and a quoted item (`> - x`) was not one. A `## Rollback`,
  `### Step` or `**Step 1:**` line in a code block also started a section or a
  step, and an unclosed `---` first line (a thematic break on the page) hid the
  rest of the runbook as front matter. They are now read by the line rule of
  the Outline and the task checkboxes.
- **`export_text` reads inline links as CommonMark does.** Any `(...)` after
  `[text]` was read as a link's destination, so `[t](a b)`, which is no link (a
  destination has no space and `b` is no title), read `t`, and `export_metadata`
  counted `![a](b c)` as an image. A wikilink was read before a link, so
  `[[[W]]](u)`, a link whose text is `[[W]]`, read `[W](u)`, and a link inside a
  link's text made the outer one a link too. The `(destination "title")` tail is
  now read by the CommonMark rule, a link holds no link, and a link's or an
  image's text is no wikilink, as on the page.
- **`export_text` no longer starts with a line break.** The text began with
  `\n` when the document started with blank lines, with front matter and a
  blank line, or with a line that reads nothing (a link reference definition,
  an HTML comment). Blank lines before the first text are now left out, as
  those after the last are; the first line keeps its indentation.
- **`export_text` keeps an `===` line the page shows as text.** Every line of
  only `=` or `-` was dropped as a setext heading underline, so an `===` line
  after link reference definitions, one with no paragraph before it and a lazy
  one after a list item (`- a`, then `===`) were lost, although the page shows
  them. Underlines are now read by the container rule of the lines and, after
  definitions, as micromark reads them, also when a `---` line underlines the
  paragraph an `===` line starts there.
- **HTML blocks and footnote definitions are read as the page reads them.** The
  line scanner behind the Outline, task checkboxes, `export_text`,
  `export_metadata` and document titles read the lines of an HTML block (a
  `<div>` or a lone `<u>` line up to a blank line, a comment up to its `-->`) as
  Markdown, although the page shows them as raw HTML. A `# x` in a `<div>` was
  listed as a heading, a `- [ ] t` in one was a task, and a link reference
  definition after `<!-- c -->` was read as part of a paragraph. GFM footnote
  definitions (`[^1]: text`) were not containers, so a task, a heading or a
  fence in one (`[^1]: - [ ] t`, or a line indented four columns after it) was
  read as paragraph text, and a footnote definition that interrupts a paragraph,
  also lazily after a blockquote, went on with it. Both are now read as
  micromark reads them, in the Rust scanner and the app's `outline.ts` alike, and
  `export_text` reads an HTML block's text without its tags. `[^a b]: x`, which
  is no footnote because its label has a space, is now dropped as a link
  reference definition.
- **The `export_text` tool description says what links read.** It said links,
  images and HTML tags are stripped, and nothing about what stays: a link's text,
  an image's alt text, the brackets of a `[text]` whose label is not defined and
  an autolink's URL, or that a link reference definition reads nothing. It now
  says so.
- **`export_text` strips markup inside link and image text.** A link's text and
  an image's alt text were copied as written, so `[**a**](u)` read `**a**` and
  ``[`code`](u)`` kept its backticks, where the page shows `a` and `code`. They
  now lose their inline marks, as the rest of the line does.
- **`export_text` drops link reference definitions and reads autolinks as
  CommonMark does.** A definition line (`[ref]: /url "title"`) read
  `ref: /url "title"`, although the page shows nothing for it. Definitions are
  now dropped, the same ones reference links are read against, also when the
  destination or the title sits on the next line or the title goes on over
  lines. Any `<` followed by a letter was read as an HTML tag up to the next
  `>`, so `<me@x.org>` read nothing and `<a href="x://y">` read
  `a href="x://y"`. Autolinks (a 2 to 32 character scheme, or an email
  address) now keep their URL or address, inline HTML reads nothing, and any
  other `<` is text. A `)` inside a `<...>` link destination
  (`[t](<a)b>)`) no longer ends the link. Checked against the renderer's
  definitions on generated documents.
- **A checkbox after a nested empty item is a task.** In `10. 1.<tab>-`, then a
  line holding `[x] t` in the `1.` item (or `- -`, then `  [ ] t`), the page
  shows a checkbox, since remark-gfm reads the line after a marker with nothing
  after it as first content also when the line leaves that item for an item it
  is in. `get_user_annotations`, the `/annotations` endpoint, the checkbox
  toggle and the task counts read it as text. They now read it as a task, and
  still read text where the line leaves the item for a blockquote. Checked
  against the renderer on generated documents.
- **Task counts follow the page's task rule.** The doc-kind badge, the status
  bar's task count, the classifier's checklist signal, a spec's acceptance
  criteria and a runbook's prerequisites matched `- [ ]` on raw lines, so a
  quoted task (`> - [ ] t`), a `1)` item and a checkbox on a bare item's next
  line were missed or read as plain text, while `    - [ ] t` (indented code)
  and `- [ ]` alone counted. They now read tasks by `taskMarks`, the rule the
  checkbox toggle uses, so they agree with the checkboxes on the page.
- **`export_text` keeps brackets that are not reference links.** Any `[text]`
  with no `(url)` after it lost its brackets, so `[sic]`, `[TODO]` or `[1]` in
  prose read `sic`, `TODO` and `1`, where the page shows the brackets. A
  reference link (`[text]`, `[text][]` or `[text][ref]`) now loses them only
  when the document defines its label (`[ref]: /url`, in any container), as
  CommonMark reads it, and the same holds for `![alt]` images. Checked against
  the renderer.
- **Clicking a task checkbox in the read view toggles it again.** The checkbox
  input that remark-rehype creates has no source position (rehype-raw keeps
  none), so the checkbox read line 0 and every click was a no-op. A rehype step
  after the sanitizer now gives each task checkbox the line of its `[ ]` from
  its list item's position, so a click checks or unchecks that task in the
  document and saves it, after front matter, in nested and loose lists, in
  blockquotes and callouts, and on a bare item's next line. A checkbox in an
  embedded note (`![[Note]]`) is read-only, since its lines are not the open
  document's, and a checkbox written as raw HTML toggles nothing.
- **Task toggles follow the page's task rule.** The app's checkbox write-back
  matched `- [ ]` with its own pattern, so a task in a blockquote
  (`> - [ ] t`), after a `1)` marker or on a bare item's next line (`-`, then
  `  [ ] t`) could not be toggled, while `    - [ ] t` (indented code on the
  page), a `- [ ]` line in fenced code and `- [ ]` alone could. It now reads
  tasks by the rule of `get_user_annotations` (`task_list::task_marks`), from
  the Outline's line scan, and changes only the character inside the brackets.
  Checked against the renderer on generated documents.
- **The editor splits off the front matter the Outline skips.** The WYSIWYG
  editor hid front matter by its own pattern, so a closer with text after it
  (`---abc`) ended the block and left `abc` in the body, while a delimiter with
  trailing spaces, a `...` closer and an empty block (`---` then `---`) were not
  split off and showed as text in the editor. It now uses the one rule of the
  Outline and mdopener-mcp, and so does the word count, which shares it.
- **Outline: no lint warning in the container scan.** `containers` in
  `outline.ts` declared `interrupt` with `let` and kept a commented-out
  assignment to it, so biome warned that it could be `const`. It is `const`
  now and the dead comment is gone; the scan reads lines as before.
- **Indented code that opens a blockquote after a list item.** After an item
  with only its marker had ended, a quoted line indented as code (`-`, a blank
  line, then `>     code`) was taken to close a container, so the next quoted
  line could open an item that cannot interrupt the code (`> 2) ...`) and its
  fence or heading. The page reads that line as paragraph text; the Outline and
  mdopener-mcp now do too. Found by checking against the renderer on generated
  documents.
- **Lint heading rules read setext headings.** `single-h1`, `max-heading-depth`,
  `no-empty-headings` and `orphaned-heading` read only `#` headings, so `Title`
  underlined with `===` and then `# Other` was not flagged as two H1s, and a
  setext heading right before another heading was not orphaned. They now read the
  setext headings the Outline counts, outside list items and blockquotes as for
  `#` headings, and a duplicate setext H1 is marked at its underline.
- **`export_text` keeps brackets that are not task checkboxes.** Any `[ ]`
  read as a link with the text ` `, so `[ ] not a task` came out as
  `  not a task` and `- [ ]` alone (text on the page) lost its brackets. Only
  a task checkbox, where `get_user_annotations` reads a task, is dropped now.
- **Front matter opens only on `---` at column 0.** The Outline, the review
  summary and mdopener-mcp trimmed the first line, so `  ---` opened front matter
  and hid the lines up to the next `---` (their headings, tasks and text), while
  the page shows that line as a thematic break and the lines as text. Each
  delimiter now starts at column 0 with only spaces or tabs after it, as
  remark-frontmatter reads it, and the Outline and the review summary share one
  helper instead of two copies. An unclosed leading `---` stays a thematic break,
  as on the page.
- **Task checkboxes are read where the page shows them.** `get_user_annotations`
  and the app's `/annotations` read `- [ ]` on raw lines, so a task in a
  blockquote (`> - [ ] t`) or an ordered item (`1. [ ] t`) was missed, and an
  indented `    - [ ] t` (code on the page) was listed. Tasks now follow the
  container rule the Outline and `export_text` use: a checkbox opens a list
  item's first content and is followed by text, as remark-gfm reads it, so
  `- [x]` alone is text. `export_text` drops the same checkboxes. Checked
  against the renderer on generated documents.
- **Outline jumps land on the right heading after a setext heading.** The
  page gives a heading underlined with `===` or `---` an id, but the
  Outline did not count it, so in a document with `Title`, `=====` and
  later `# Title`, the Outline's entry for `# Title` jumped to the setext
  heading. Setext headings now take their slug as the page does. They are
  still not listed, as `export_metadata` lists only `#` headings.
- **List items inside a blockquote are read across lines.** Only the
  items before a document's first `>` were tracked, so in `> - a` the
  item's later lines (`>     # Sub`, `>     **b**`) were read by their
  indentation in the quote: as indented code, so the Outline gave that
  heading no slug and a later `# Sub` jumped to the wrong place, and
  `export_text` kept their Markdown. A fence in such an item also ran past
  a line that leaves the item, so quoted text after it was read as
  Markdown. Items in blockquotes are now tracked, in the app and in
  mdopener-mcp, checked against the renderer on generated documents.
- **`export_text` reads a list item's heading as a heading.** It took
  quote leaders, `#`s and list markers off each line itself, so `- # Step`
  read `# Step`, a heading on an item's continuation line (`1. a`, a blank
  line, then `    # Sub`) kept its `#`, and `1)` and tab-separated markers
  stayed. Each line is now read past the blockquote markers, list markers
  and item indentation it sits in, by the rule the headings and fences
  follow.
- **Lint no longer reads a list item's heading as a document heading.**
  A heading on a list item's continuation line (`- x`, a blank line, then
  `  # Sub`) was counted by the heading rules, so a second `# ` there was
  flagged as a duplicate H1, a deep one as too deep, and the heading
  before it as orphaned. The heading rules now skip headings in list items
  and blockquotes, as the Outline does.
- **A failed inline AI edit no longer doubles the selected text.** When
  an inline AI action failed or was cancelled before any output arrived
  (a refused key, an empty account, a network error), both editors put
  the selection back in front of itself, so `hello world` with `hello`
  selected read `hellohello world`. The selection is now left as it was.
- **`export_text` says how it keeps code.** Its description said code
  block contents are kept as-is, though code in a blockquote or a list
  item loses the `>` markers and indentation it sits in, and indented
  code its four columns, so an agent could match the text against the
  source with them. It now says what is taken off.
- **Docs: `stream_edit` with `path` reads only the open path.** The
  `docs/AGENTS.md` row said a `path` made it fetch the whole document to
  compare, which it stopped doing when the app gained a path-only route,
  so an agent could leave out the check on a large document. It now says
  only the open document's path is asked for.
- **`stream_edit` says its result has no diff without a preview.** With
  `preview: false` the edit is applied at once and the result's `diff` is
  empty and `candidates` null, but the description called `diff` the diff
  of the first match in every case, so an agent could read the empty diff
  as an edit that changed nothing. The description and docs now say so.
- **`export_metadata`'s description says which headings it lists.** It
  promised a "headings tree" of every ATX heading outside front matter and
  fenced code, so an agent looked for nesting and for headings in quotes
  and list items. It now says `headings` is a flat list in document order
  that leaves out empty headings and those in blockquotes and list items,
  and that images in fenced code and front matter are not counted.
- **`export_text` keeps indented code in a list item as code.** A line
  indented four columns past a list item's text (`- a`, a blank line, then
  six spaces and `# step`) or past a blockquote's `>` is indented code, as
  the preview renders it, but after a list item every indented line was
  read as text until the list ended, so agents read such code without its
  `#`s and `*`s. It is now kept as code without the item's indentation,
  and a line indented less is still the item's text.
- **`export_text` strips a list item's indentation from its code.** Code
  from a fence in a list item kept the item's indentation in the plain
  text agents read, while code in a blockquote lost its `>` markers. Both
  now read as CommonMark renders them: the item's indentation and the
  fence's own indentation are taken off, deeper indentation is kept.
- **More fences in list items are read as code.** A fence on a list
  item's continuation line (`- a`, a blank line, then the fence indented
  to the item's text), in an item indented four spaces or more under its
  parent, after a tab after the marker, or in a quote in an item (`- > `
  then a fence) was read as text. A `# comment` in its code was listed in
  the Outline, and agents' `export_metadata` and task tools read its
  `[[links]]`, headings and `- [ ]` lines as the note's own. The app and
  mdopener-mcp now read each as a fence, as the preview renders it.
- **The Outline leaves out a heading on a list item's continuation line.**
  A heading indented to a list item's text after a blank line (`- x`, a
  blank line, then `  # Sub`) or after a bare `-` is part of the item, and
  the Outline already left out headings in list items. It was still
  listed. It is now counted for the page's heading ids but not listed.
- **Partial embeds, link previews and agents skip a list item's heading.**
  A heading on a list item's continuation line (`- x`, a blank line, then
  `  # Sub`) was still a heading of the note for `![[Note#Sub]]` embeds,
  link previews, Related notes and document kinds, and agents'
  `export_metadata` listed it and could take it as the title. They now
  leave it out, as the Outline does, by the container rule fences follow.
- **The Outline lists a heading after a list marker that opens no item.**
  `2. z` after a paragraph (it cannot interrupt one) or a bare `-` before
  an unindented line was read as a list item holding the `   # Sub` after
  it, so that heading was left out of the Outline. The Outline now reads
  list items and blockquotes by the rule fences follow, which agrees with
  the preview on every ATX heading of a generated test corpus.
- **The inline AI's Retry pause is one constant.** Both editors computed
  a doubling delay (500 ms times 2 to the retry count) for a Retry that is
  offered only once, so it was always 500 ms. They now share that 500 ms
  pause as a constant; the Retry button works as before.
- **The AI sidebar's retry toast is styled.** The toast shown after a
  failed generation, its Retry, Open Preferences and Add credit actions
  and its dismiss button had no styles, so they showed as bare browser
  controls. They now match the app's buttons and error accents in every
  theme, and the editors' Add credit link looks like their buttons.
- **The editors' inline AI offers the fix, not a Retry that fails again.**
  After a refused key or an account out of credit, the inline AI in both
  editors still offered Retry. It now offers Open Preferences or an Add
  credit link, as the AI sidebar does.
- **The Outline jumps to the right heading after one inside a numbered
  item.** A heading indented four spaces under `1. x` (after a blank line)
  is a heading in the item, and the page gives it an id, but the Outline
  read it as code and counted no id for it, so a later heading with the
  same text jumped to the wrong place.
- **Code inside a list item is code.** A fence that opens a list item
  (`- ` then a fence) was read as text, so a `# comment` in the item's
  code was listed in the Outline and `- [ ] x` in it read as a task. It
  is now a fence in the app and in mdopener-mcp, closed by its fence or by
  a line indented less than the item's text.
- **The inline AI's retry comment matches what it does.** The source
  editor said a failed rewrite got "one automatic retry with exponential
  back-off", but the Retry button runs it once after a 500 ms pause and
  nothing retries on its own. Both editors now say so.
- **A refused key or an empty account no longer offers a Retry.** After
  Anthropic refused the key (or the cloud token) or said the account was
  out of credit, the sidebar's toast offered Retry, which failed the same
  way. It now offers Open Preferences or Add credit instead.
- **The AI sidebar says when a long document is cut.** Only the first
  8,000 characters of the document go to the AI, and that was silent, so
  questions about the rest got guesses. A short note under the quick
  actions now says how much the AI sees.
- **A greyed-out AI quick action says why.** Its tooltip repeated its
  label, so on an empty document or while an answer streamed the buttons
  were disabled with no reason. The tooltip now names it.
- **The Outline jumps to the right heading after a list-item one.** A
  heading in a list item (`- # Step`) is not listed, as in
  `export_metadata`, but the page gives it an id, so a later `# Step` is
  `step-1` there while the Outline linked `step`. Its slug now counts.
- **Code inside a blockquote is code.** A fence behind `>` markers was
  read as text, so a `[[link]]` in quoted code was linted as a missing
  link and `export_text` dropped the `#` of a quoted `# comment`. Quoted
  fences are now fences in the app and in mdopener-mcp, closed by their
  fence or by a line with fewer `>` markers.
- **The Outline jumps to the right heading after a quoted one.** A heading
  inside a blockquote (`> # Plan`) stays out of the Outline panel and
  `export_metadata`'s headings, as in Obsidian's outline, so quoted text
  from elsewhere does not clutter it. The read view still gives that
  heading an id, though, so a later `# Plan` is `plan-1` in the page while
  the Outline gave it `plan` and jumped into the quote. The Outline now
  counts a quoted heading's slug without listing it.
- **Task totals skip code and front matter.** The agent badge and the
  status bar's "done / total tasks" counted every `- [ ]` line, so a plan
  that showed a task list in a code sample, or kept a to-do list in its
  front matter, reported tasks nobody could tick. Tasks are now read
  outside front matter and fenced code, by the rule the Outline uses.
- **"Frontmatter required" accepts a block closed by `...`.** The lint
  rule used its own pattern, so front matter closed by a YAML `...` line
  (which the Outline, Obsidian and `export_metadata` read as front matter)
  and an empty `---`/`---` block were flagged as missing, while a `----`
  line closed a block. It now uses the Outline's front matter rule.
- **"No bare URLs" skips every code block and front matter.** The rule
  blanked only text between one ```` ``` ```` and the next, so a URL in a
  `~~~` block was flagged, a ```` ```` ```` block that shows a ```` ``` ````
  fence ended early, and a URL property in front matter was flagged with a
  fix that broke the YAML. Code and front matter are now read by the
  Outline's rules.
- **The selection popover's Translate button names its language.** The
  popover has no language picker, so Translate always answered in Spanish,
  but its button read only "Translate". The button now reads "To Spanish"
  (titled "Translate to Spanish"), and the chat shows the same label.
- **The AI setup panel can check again.** The sidebar looked for a provider
  only when it opened, so starting Ollama with the "No AI provider found"
  panel open changed nothing until the sidebar was closed and reopened. The
  panel now has a "Check again" button, which says so when it still finds
  none. Its key button read "Save key & retry" but retried nothing; it now
  reads "Save key".
- **Inline AI with no provider opens the setup panel.** In both editors, a
  rewrite with no AI provider said "No AI provider. Set one up in the AI
  sidebar." and left the user to find the sidebar. The message now has a
  "Set up AI" button that opens it, as the selection popover's does.
- **MCP: a wikilink's target agrees with the app.** `export_metadata`
  took everything between `[[` and `]]` (before a `|`) as the target, so
  `[[Plan#Goals]]` listed `Plan#Goals`, a note that does not exist, and
  `[[a]b]]` listed `a]b`, which the app does not link. The target is now
  the note without its `#heading`, and a `]` ends no target. A new
  `wikilink_headings` field beside `wikilinks` lists each link's
  `{ target, heading }`. `export_text` shows `[[Plan#Goals]]` as the read
  view does, `Plan › Goals`, and the embed count follows the same rule.
- **Related notes, the agent badge and link previews read headings and
  front matter as the outline does.** Related notes searched by the first
  column-0 `#` line, which could be a front matter comment or a line of
  code. The agent document badge counted `#` lines in code blocks as
  headings, so a shell script's `# src/main.ts` comments made a document
  "multi-file", a `## ` line in a code sample ended a spec's acceptance
  criteria, and numbered lines in code counted as runbook steps. A link
  preview without a heading ended front matter at any later `---`, even
  mid-line, so a document opening with a thematic break lost its first
  lines; front matter now ends on a `---` or `...` line. (The AI
  sidebar's document type hint still scores raw `#` lines, as a cheap
  hint that also reads the words in code.)
- **Lint heading rules skip code and front matter.** "Single H1",
  "No empty headings", "Max heading depth" and "No orphaned headings"
  tested each line against a column-0 `#` pattern, so a `# comment` in a
  code block or front matter was linted as a heading and `  ## Indented`
  was not. They now read headings as the Outline panel does. The "Max
  heading depth" fix rewrites the heading it flags; it used to rewrite the
  first line starting with as many `#`s, which could be a line of code.
- **The wikilink lint skips code, and an image embed is one line.** The
  "wikilink targets exist" lint reported a `[[link]]` inside fenced code,
  which `export_metadata` does not list; it now skips fenced code by the
  same fence rule and still reads a front matter property such as
  `related: "[[Plan]]"`, as Obsidian does, without taking a front matter
  line as a fence. Dragging an image in the editor read an unclosed
  `![[` up to a `]]` lines later as one embed; an embed now ends on its
  own line.
- **MCP: `export_text` strips a heading in a blockquote.** A heading's
  `#`s were taken off before the `>` leaders, while the line still
  started with `>`, so `> # Quote` read `# Quote`. The leaders now go
  first, then the ATX rule of `export_metadata`'s headings.
- **MCP: `export_text` reads a wikilink as its text.** A `[text]` link
  was read before a wikilink, so `[[Real]]` became `[Real]` and
  `[[Plan|the plan]]` became `[Plan|the plan]`; an image was read before
  an embed, so `![[a.png]]` left `[a.png]`. A wikilink now reads its
  target, or its alias when it has one, as the read view shows it, and an
  embed reads nothing.
- **The outline, embeds, previews and wikilinks agree with the MCP
  server.** The Outline panel listed a tab-indented `# x` (indented code)
  and showed `## ##` as `#`, and its fence rule took a tab-indented
  ```` ``` ```` or a backtick fence with a backtick in its info string as
  a fence. A `![[note#Heading]]` embed and a link preview found headings
  inside fenced code and front matter, and an embed did not find
  `## Goals ##` by `Goals`. All of them now read headings by the ATX and
  fence rules of `export_metadata`. A wikilink or an embed in the read
  view, and in the "wikilink targets exist" lint, now ends on its own
  line, so an unclosed `[[` no longer pairs with a `]]` lines later.
- **MCP: a wikilink or an embed is one line.** `export_metadata` looked
  for the `]]` that closes a `[[` across newlines, so an unclosed `[[`
  took the text up to a `]]` many lines later as its target and hid the
  links in between, and an unclosed `![[` was counted as an image. A
  wikilink or an embed now ends on its own line, as in Obsidian, in the
  `wikilinks` and the `embedded_image_count`.
- **MCP: `export_text` keeps indented code as code.** A line was trimmed
  before its `#`s were taken off, so a `# comment` indented four spaces
  lost its `#` and the `*` and `_` of indented code were stripped as
  emphasis. Headings now follow the ATX rule of `export_metadata`, and
  indented code that opens after a blank line or a heading is kept as
  written without its indent. Inside a list an indented line is still read
  as the item's continuation, so code there may be read as text, but text
  is never read as code.
- **MCP: a title and the headings read a heading the same way.**
  `export_metadata`'s headings trimmed the whole line, so a `# comment`
  indented four spaces (indented code) was a heading, while a recent
  document's `title` took only `# ` at the start of a line, so
  `  # Title` and `#<tab>Title` were not titles and `# Title #` kept its
  closing `#`. Both now use one CommonMark rule from the shared helper: at
  most three spaces, 1 to 6 `#`s, then a space, a tab or the end of the
  line, with closing `#`s dropped. An empty `# ` is no longer a title.
- **MCP: plain text, image counts and tasks use the same fence rule.**
  `export_text`, `export_metadata`'s `embedded_image_count` and the
  `tasks` of `get_user_annotations` (and of the app's `/annotations`)
  flipped "in code" on any line starting with ```` ``` ```` or `~~~`, or
  did not skip code at all. A `~~~` line inside a backtick block ended it,
  so `export_text` stripped the `#` and `*` of the code after it and the
  images there were counted, and a `- [ ]` line in a code sample was
  listed as a task. All three now read their lines through the shared
  helper; the image count and the tasks also skip front matter.
- **MCP: `export_metadata` wikilinks use the same fence rule.** Any line
  starting with ```` ``` ```` or `~~~` flipped "in code", so a `~~~` line
  inside a backtick block made the `[[links]]` in the code after it count
  and those after the block not, and a ```` ``` ```` line in a front
  matter block scalar hid every link in the body. Wikilinks now skip
  fenced code by the headings' rule. Front matter is still read, so a
  property such as `related: "[[Plan]]"` links to `Plan` as Obsidian reads
  it, but its lines are never fences.
- **MCP: `export_metadata` headings skip front matter and code.** A
  `# comment` in YAML front matter was listed as a heading, and any line
  starting with ```` ``` ```` or `~~~` flipped "in code", so a `~~~` line
  or a shorter fence inside a block ended it early and the shell comments
  after it became headings. Headings now follow the rule a recent
  document's `title` uses: a leading front matter block is skipped, a
  fence is closed only by the same character at least as long with
  nothing after it, and a fence left open runs to the end. Both use one
  shared helper.
- **MCP: the current document says what any other HTTP error is.**
  `mdopener://current`, `mdopener://recent-documents` and the prompts
  answer `-32000`, with the app's reason as the message, when the app
  answers an HTTP error other than 401 (a 404 or a 500). Their
  `resources/list` and `prompts/list` text and docs/AGENTS.md said nothing
  about it. They now do, and a 500 whose reason held "not found" or
  "connect" is no longer reported as Ashlr MD not running, for every tool.
- **MCP: the prompts say what `-32000` means.** Each prompt's
  `prompts/list` description, and docs/AGENTS.md's prompts reference, said
  `-32000` means the app is not running. It is also the code, with the
  refused-token message, when the app answers HTTP 401. They now say both,
  as the `mdopener://current` entry does.
- **MCP: `resources/list` percent-encodes its `file://` URIs.** A vault
  file was listed as `file://` followed by its path as is, so a path with a
  space, `%`, `#` or `?` was not a valid URI. The path is now
  percent-encoded as RFC 3986 and RFC 8089 require (`My Notes.md` is
  `My%20Notes.md`, and a Windows path `C:\notes\a.md` is
  `file:///C:/notes/a.md`). `resources/read` takes both the encoded URI
  and the old unencoded form, so existing clients keep working.
- **MCP: a recent document's `title` skips front matter and code.** The
  `mdopener://recent-documents` `title` was the first line starting with
  `# `, even inside YAML front matter or a fenced code block, so a front
  matter comment or a shell comment such as `# install it` named the
  document. Lines of a leading front matter block and of fenced code
  (```` ``` ```` or `~~~`, closed by the same fence at least as long) are
  now skipped; with no other `# ` heading the title is the file name, as
  before.
- **MCP: the vault-search resource entry names every `note`.** The
  `resources/list` entry for `text://vault-search` said `note` reports
  only that semantic search or the app's own search was unavailable. It
  also reports semantic results that leave out documents whose embedding
  failed, vault files that could not be read and so were not searched, and
  a search of the `vault` folder on disk because the app could not be
  reached or refused this server's token. The entry now names each, as
  `search_vault`'s description does.
- **MCP: the resource entries say what `-32000` means.** The
  `mdopener://current` and `mdopener://recent-documents` entries of
  `resources/list`, and docs/AGENTS.md's resources reference, said
  `-32000` means the app is not running. It is also the code, with the
  refused-token message, when the app answers HTTP 401. They now say both,
  and so does docs/AGENTS.md for a `file://` read.
- **MCP: the stream-edit tools no longer fetch the document to check
  `path`.** `stream_edit` and `stream_edit_apply` with `path` asked the
  app's `/content` for the open document's path, which sent its whole
  content (up to 16 MiB) to compare one field. The app has a new
  `GET /content/path`, with the same token check, that answers the path
  alone, and the tools ask it instead (an app without it is asked
  `/content`, as before). What the tools send and the errors they give are
  unchanged.
- **MCP: the vault-search resource entry names `limit`.** The
  `resources/list` entry for `text://vault-search` named `&vault=` and
  `&semantic=` but not `&limit=`, which a read takes and the template
  names. It now names it with its range and default, and docs/AGENTS.md
  says that listing the template needs no app but reading it does unless
  `&vault=` is given (it said only "it needs no app").
- **MCP: `text://vault-search` takes only `semantic=true` or `false`.** The
  resource descriptions, docs/AGENTS.md and the error all say `true` or
  `false`, and docs/AGENTS.md that any other value is `-32602`, but `1`
  and `0` were taken as true and false. They are now refused like any
  other value, as the `search_vault` tool's boolean `semantic` refuses a
  number.
- **MCP: `text://vault-search` decodes an encoded `limit`.** `q`, `vault`
  and `semantic` were percent-decoded but `limit` was not, so
  `limit=%35` was refused as not a whole number from 1 to 200, got "5".
  It is now decoded like the other values.
- **MCP: the server instructions name the no-app tools correctly.** They
  said the tools that work without the app all work "on files on disk",
  but `list_ai_actions` and the conversation tools read no file you name,
  and to pass `path` to `diff_documents`, which takes `path_a` and
  `path_b`. They now say `path` for `export_text` and `export_metadata`,
  that `diff_documents` and `edit_canvas` work on the files they are given,
  and list the rest as tools that work without the app.
- **AI: "Explain selection" said it explained a selection.** The
  `doc-explain-selection` action has scope `document`, and the AI sidebar
  sends it the document (its first 8,000 characters), never a selection, but
  its label was "Explain selection" and its prompt told the model the user
  would provide selected text. The label is now "Explain doc" and the prompt
  asks for an explanation of the document, in the app and in
  `list_ai_actions`. The id and scope are kept: `list_ai_actions` clients and
  its description read them. That description now also says the app sends at
  most the first 8,000 characters of a document.
- **MCP: `stream_edit` no longer says to prefer it for large files.** Its
  description said "Prefer this over edit_document for large files", but
  neither tool sends the document: both post the app only `find` and
  `replace`, a preview adds a diff and a second call, and `stream_edit`
  with `path` even fetches the whole document to compare paths. It now
  says to prefer it only to see the change before committing it, since
  `edit_document` applies at once, and why size is no reason.
- **MCP: `edit_canvas` spells "color" as its schema does.** Its description
  said "set node colour" and a refused color said "a hex colour", while the
  op is `set_node_color` and the `color` field says "Color preset". Both now
  say "color", as docs/AGENTS.md does.
- **MCP: `export_text` and `export_metadata` say what they read without
  `path`.** Their descriptions said they operate on disk and return the
  path of "the file read", but without `path` they read the open document
  from the app as the window holds it, edits not yet saved included, not its file
  on disk. They now say so; with `path` they still read the file on disk.
- **MCP: `present_document` no longer promises a full-screen view.** Its
  description and the server instructions said it switched the app into a
  "full-screen" presentation, but the window only enters Zen mode (Read
  view with the title bar, tabs, status bar and side panels hidden) and
  keeps its size. They now say that, and that Escape leaves it.
- **Lint: `biome check src` reports no errors again.** CI's Check (Linux)
  job runs it, and it failed on formatting in `src/mcp/handlers.test.ts`,
  `src/mcp/bridge.test.ts` and `src/mcp/handlers/edit.ts` and on the import
  order of `src/docFacts.test.ts`. Those are formatted, and the `src/mcp`
  warnings and infos (a `void` in a union type, string concatenation where
  a template literal reads better) are fixed too. No behaviour changes.
- **MCP: every path parameter says it takes `~/`.** Every path argument
  expands a leading `~` for the home directory, but the descriptions of
  `path`, `path_a`, `path_b`, `vault` and `cited_docs` said only "absolute,
  or relative to this server's working directory", and `output_path` said
  only how a relative path resolves. Each now says "absolute, `~/...` for the
  home directory, or relative to this server's working directory".
- **MCP: a `stream_edit` refusal that did not search has no `matchCount`.**
  With no document open, a `path` that is not the open document, or an
  exception in the window, the window sent `matchCount: 0`, so the tool's
  error said `find` occurs nowhere although nothing was searched. Those
  refusals now carry no `matchCount`; a search that found nothing still
  says `0`. The app's `StreamEditPreviewOutcome.match_count` is optional,
  and the `stream_edit` description and docs/AGENTS.md say which refusals
  carry a count.
- **MCP: a path may start with `~/`.** No shell expands `~` inside a JSON
  argument, so `~/notes/plan.md` was resolved as a folder named `~` in the
  server's working directory, and every path tool said the file did not
  exist. A leading `~` (alone, or followed by `/`) now stands for the home
  directory in every path argument: `path`, `path_a`, `path_b`, `vault`,
  `output_path` and each `cited_docs` entry. `~user` is kept as given.
- **MCP: a document that is not UTF-8 says where and what to do.** A Latin-1
  or UTF-16 file (as some Windows editors save) was refused by `export_text`,
  `export_metadata`, `diff_documents`, `edit_canvas` and the other disk reads
  with the bare "stream did not contain valid UTF-8". The reason now names
  the first byte that is not valid UTF-8 and its line (or says the file is
  UTF-16) and says to convert the file to UTF-8. `get_user_annotations`'
  `tasksNote` also ran a reason without a full stop into "Its tasks were not
  read."; it is two sentences now.
- **MCP: a request larger than the app reads is refused before it is sent.**
  The app reads at most 16 MiB of one request; past that it answers 413 and
  closes the connection, so `set_content`, `replace_document`,
  `edit_document`, `stream_edit`, `stream_edit_apply` and `request_review`
  with a larger text reported "IPC write error: Connection reset by peer",
  which read as a crashed app. They now refuse it with `-32602` before
  sending anything (the size is counted with JSON escapes), saying what to
  do instead: change part of the document with `edit_document`, split the
  edit, or pass the review text as a file's `path`.
- **MCP: `search_vault` says which vault files it could not read.** A vault
  or recent Markdown file that is not UTF-8 text, is larger than 16 MiB or
  cannot be read was left out of the on-disk searches (modes `grep-disk`,
  `grep-local` and `semantic`) in silence, so words in it came back as no
  hits. The `note` now says how many files were not searched, names the
  first three with the reason (`/v/latin.md (not UTF-8 text (byte 4 is not
  valid UTF-8, on line 1))`), counts the rest, and says to convert a file
  that is not UTF-8.
- **The app's own search says which vault files it could not read.** The
  app's `/search` (`search_vault` in mode `grep`) left a vault or recent
  file it could not read (not UTF-8 text, larger than 16 MiB, or refused)
  out in silence, as the on-disk modes did. Its reply now lists them as
  `unread: [{ path, reason }]` (the first 20) with `unreadCount`, and
  `search_vault` turns them into the same `note` as the on-disk modes. An
  app that predates the fields gives no note, as before.
- **Reindexing the library says which files it could not read.** The app's
  semantic index (the "My library" chat) left a file it could not read (not
  UTF-8 text, larger than 16 MiB, not a regular file) out in silence, so the
  chat could not know it and nothing said why. `embed_index` now returns
  them as `unread` with the reason, and **Reindex library** in Settings says
  how many files were not indexed, names the first three with the reason,
  and says to convert a file that is not UTF-8.
- **MCP: a `find` that is not found says what to do.** `edit_document`,
  `stream_edit` and `stream_edit_apply` answered "`find` string not found
  in the document." and stopped, so an agent retried the same text. The
  error now says `find` must match the document exactly, whitespace and line
  breaks included, and to copy it from `get_current_content`. A
  `match_index` past the last occurrence names the range to use (`Use a
  match_index from 0 to 1`) or says to call `stream_edit` again.
- **MCP: `open_file` reports a failed read of the open document, and
  `stream_edit` counts a `find` that is not unique.** The window decided
  whether `open_file` worked by looking at which document was open
  afterwards, so a read of the path that was already open that failed was
  reported as opened. It now takes the outcome of its own read. And
  `stream_edit` with `preview: false` and a `find` that matches more than
  once answered the server with `matchCount: 0`; it now sends the number of
  occurrences, as a preview does (the error already says "not unique (3
  matches)").
- **MCP: `set_content` and `replace_document` no longer promise a result
  that never comes.** Their descriptions said that with `save: true` "a
  document with no file yet" is an error saying the content was replaced
  but not saved. The app opens only files, and with none it shows its
  welcome screen, so the window refuses such a call as "No document is open
  in Ashlr MD; open one first (open_file)." before it applies anything. The
  descriptions now say that, and that a failed save is the error that says
  the content was replaced but not saved.
- **MCP: the find/replace edits refuse a buffer with no file, and no longer
  promise "applied but not saved" for one.** The `edit_document` and
  `stream_edit_apply` descriptions said that with `save: true` "a document
  with no file yet" is an error saying the edit was applied but not saved.
  The app opens only files, so a state with no path is its welcome screen,
  but the window refused it only when its buffer was also empty: an edit to
  a buffer with no file that was not empty was applied out of sight.
  `edit_document`, `stream_edit` and `stream_edit_apply` now refuse any state
  with no file as "No document is open in Ashlr MD; open one first
  (open_file).", as `set_content` does, and the descriptions say so.
  `stream_edit` with `preview: false` says the edit is not written to disk
  instead of "unsaved".
- **MCP: `get_current_content` says what a null `path` means.** Its
  description said "`path` is null for an unsaved document", and
  `export_text` and `export_metadata` that `path` is "absent for an unsaved
  open document". The app opens only files, so it has no unsaved document:
  it answers `path: null` only when no document is open (its welcome
  screen, with empty content), which these tools report as an error. The
  descriptions and docs/AGENTS.md now say that, and that `path` is the open
  document's file.
- **MCP: a refused `stream_edit` keeps the window's match count.** When
  the window refused a stream edit (a `find` that is not found, or with
  `preview: false` not unique), it sent its `matchCount`, but the app's
  `/stream-edit` reply was `{ ok: false, error }` and dropped it. The reply
  now carries `matchCount` too, and the tool's error result has it beside
  `content` and `isError`; the error text and the rest of the result are as
  they were.
- **MCP edits: no answer for a document with no file is left in the
  window.** Every edit now refuses a state with no file ("No document is
  open") before it saves or checks a preview, so the save reason "the
  document has no file yet" and the name "an unsaved document" in a
  stale-preview refusal could no longer be given. They are removed, and a
  preview's file is typed as a path, never `null`. No reply changes.
- **MCP: the reads treat `path: null` as no document, whatever its
  content.** `get_current_content`, `mdopener://current`, the prompts and
  `export_text` / `export_metadata` without `path` refused the app's
  `path: null` answer only when its content was also empty, so a buffer
  with no file and some text read as a document (and the exports gave no
  `path`), while the edit tools refuse that state. Each now gives its own
  "no document open" error for any `path: null` answer, with the text it
  had, and the exports' result always has `path`.
- **MCP: a `stream_edit_apply` refused by its search says how many
  matches there are.** When `find` was no longer in the document or
  `match_index` was past its last occurrence, the result had only the error
  text (the out-of-bounds one names the count in words). The window now
  sends its count, the app's `/stream-edit-apply` reply passes it on, and
  the tool's error result has `matchCount` beside `content` and `isError`.
  A refusal that did not search (no document open, a `path` that is not
  the open document, a stale `edit_id`, a busy app, a window that does not
  answer) has no count, and neither does an older app; no count is made
  up. The Rust-side `/stream-edit` refusals (an empty `find`, a `path`
  mismatch, a busy app, a timeout) are not searched either, so they still
  carry none.
- **App IPC: a test comment no longer describes an unsaved document.** A
  comment in `src-tauri/src/ipc.rs` said "Unsaved buffers have no path to
  resolve" and its check compared `Untitled` with itself, although the app
  opens only files. It now describes the real case, a file deleted or moved
  since it was opened, and checks that path; a doc-facts test keeps
  `ipc.rs` and the edit handlers from naming an unsaved document again.
- **MCP: the edit descriptions no longer say a late window changed
  nothing.** `set_content`, `replace_document`, `edit_document`,
  `stream_edit_apply` and `stream_edit` with `preview: false` listed "the
  window does not answer within 4 s" among the refusals that leave the
  document unchanged, and docs/AGENTS.md said the same, but the app's
  timeout error says the window may still apply the edit and to check with
  `get_current_content` before retrying. The descriptions and rows now say
  that. A `stream_edit` preview applies nothing, so its timeout is still
  listed as a refusal.
- **MCP: `export` and `present_document` with no document open name the
  next step.** They answered "No document is open; open one before
  exporting." and "No document is open to present.", without the tool that
  opens one. `export` now says to call `open_file` with the document's
  `path` and mode "read", then retry, and `present_document` says to pass
  `path`, or to call `open_file` with the document's `path` first. The
  app's IPC and its window give the same text.
- **The app says where a document is not UTF-8, and what to do.** Opening a
  Latin-1 or UTF-16 file in the window, or through `open_file`,
  `present_document` or `request_review`, and applying a patch to one, failed
  with the bare "stream did not contain valid UTF-8". The app now gives the
  reason mdopener-mcp gives: the first byte that is not valid UTF-8 and its
  line (or that the file is UTF-16), and to convert the file to UTF-8.
- **MCP: `edit_canvas` takes `.canvas` in any case.** Only an exact
  lowercase `.canvas` was accepted, so `Board.CANVAS` was refused while
  Markdown extensions match in any case. Any case is taken now, and a `path`
  that is not a canvas is refused with `-32602` naming the path. The docs of
  `search_vault`'s `vault` walk now also say that a file symlink is followed
  (the file it resolves to is searched under that path); only directory
  symlinks are skipped, as before.
- **`mdopen` reports a refused token even when the URL scheme opens the
  file.** On an HTTP 401 from the running app, the CLI falls back to the
  `mdopener://` URL, and when that launch succeeded the stale
  `~/.mdopener/ipc-token` was never mentioned. The open still exits 0, but
  the refused-token text and its fix (quit every Ashlr MD window and start it
  again) now go to stderr, the way an unconfirmed launch is reported.
  `--hook` stays silent.
- **`stream_edit_apply` checks the preview's `editId`.** The app forwarded
  the `editId` to the window without looking at it, so a stale preview
  re-found `find` in whatever document was open now, perhaps another one.
  The window now remembers its pending previews: an `editId` it has no
  pending preview for (already applied, made before the app last started,
  or never made), a preview of another document, or a `find`/`replace` that
  is not the preview's is refused with the reason and "Call stream_edit
  again for a fresh preview, then stream_edit_apply with its editId.", and
  the document is unchanged. A preview applies once. An apply without
  `edit_id` re-finds `find` as before.
- **MCP: `search_vault` without `vault` after a refused token names `vault`.**
  On an HTTP 401 with no `vault` argument, `search_vault` returned only the
  shared refused-token message, so the agent could do nothing but wait for
  the user to restart the app. It now adds "To search without the app, pass
  `vault`: the directory of Markdown files to grep on disk.", as it does when
  the app is not running; a 401 with `vault` already searched that folder.
- **`mdopen` and `stream_edit_apply` name the right next step.** The `mdopen`
  CLI's HTTP 401 text, "IPC auth failed (stale ~/.mdopener/ipc-token)", gave
  no next step; it now says the token is stale or belongs to another Ashlr MD
  instance, and to quit every Ashlr MD window and start it again. With the
  app closed, the MCP `stream_edit_apply` said to call `open_file` and then
  call it again, but the `editId` of a preview from before the app started no
  longer exists; it now says to start the app, then call `stream_edit` again
  for a fresh preview.
- **MCP: `search_vault` after a refused token says why and how to fix it.**
  Results grepped on disk after an HTTP 401 had a `note` quoting the raw
  "IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token". The
  `note` now gives the cause and the fix of the shared refused-token message
  (quit every Ashlr MD window, start the app again, then search again). With
  `vault`, a 401 now searches that folder on disk (mode `grep-disk`), as an
  unreachable app does, instead of failing.
- **MCP: `open_file` does not launch past a refused token.** An app that
  answered HTTP 401 (a stale `~/.mdopener/ipc-token`, or another Ashlr MD
  instance on the port) was not read as a refusal, so `open_file` fell
  through to the `mdopener://` URL launch, and a launch that failed said "the
  app is not running (IPC auth failed...)" though an app had answered. It now
  returns the shared refused-token message (quit every Ashlr MD window, start
  the app again, then retry) and launches nothing.
- **"Explain changes" ends like a sidebar chat turn.** The change banner's
  answer streams into the AI sidebar, but the sidebar's Stop button could not
  stop it (the banner kept no controller the sidebar could reach), a stop was
  not marked as stopped, and a failure was appended to the answer as
  `*Error: ...*` text. Stop now aborts it and marks the turn stopped, and a
  failure is a failed turn with the same mapped message the sidebar shows
  for its own requests.
- **MCP: `get_user_annotations`' `tasksNote` says the file does not exist.**
  Read from disk (the app closed, or refusing the token), a missing file's
  `tasksNote` quoted the raw OS error ("No such file or directory (os error
  2)"). It now reads "Cannot read '<path>': the file does not exist. Its
  tasks were not read.", as the other disk tools say it.
- **MCP: a closed app names the `open_file` call for a tool given `path`.**
  With Ashlr MD not running, `request_review`, `present_document`,
  `edit_document`, `stream_edit` and `stream_edit_apply` said to "use
  open_file which can start it", leaving the agent to work out the call.
  Given a `path`, they now say `Call open_file with {"path":"..."}` with that
  exact (absolute) path, then call the tool again. `list_recent`'s
  description now says it needs the app.
- **MCP: a refused token says why and what to do, in every app tool.** An
  app that answered HTTP 401 (a stale `~/.mdopener/ipc-token`, or another
  Ashlr MD instance on the port) gave every app tool but
  `get_user_annotations` the bare "IPC auth failed: token mismatch or missing
  ~/.mdopener/ipc-token", with no next step. They now share one message that
  names both causes and says to ask the user to quit every Ashlr MD window
  and start the app again, then retry, in the words of
  `get_user_annotations`' `appAuthFailed` note. A `request_review` that hits
  it while waiting adds that restarting ends the review, so request a new
  one.
- **MCP: `get_user_annotations` reads the file on disk when the app refuses
  the token.** An app that answered HTTP 401 (a stale
  `~/.mdopener/ipc-token`, or another Ashlr MD instance on the port) gave the
  bare "IPC auth failed" error, with no tasks and no next step, while a
  closed app got the disk fallback. It now reads the task checkboxes from
  disk too, with `verdict` and `comments` `null`, `appAuthFailed: true`, and a
  `note` naming the token and saying to quit and restart Ashlr MD.
- **MCP: `export_text` and `export_metadata` without `path` say to pass it
  when the app is closed.** Both read any Markdown file on disk without the
  app, but called without `path` while Ashlr MD was not running they said
  only to launch it. The error now ends "To read a file without the app,
  pass `path`: the Markdown file to read from disk."
- **Provider detection that fails shows the setup panel.** When finding an
  AI provider threw an error, rather than finding none, a selection popover
  action left its "Set one up here" message in the AI sidebar's chat, which
  stayed on screen with no setup controls; a sidebar opened then could also
  stay on "Detecting AI" for good. Both now clear the provider, so the
  sidebar shows its setup panel with the message on top.
- **"Explain changes" with no provider shows why on the setup panel.** The
  change banner's note that no AI provider was found was written as plain
  chat text, which the AI sidebar's setup panel hides, so the user saw the
  panel and no reason. It is now recorded as a failed turn, which the panel
  shows on top of its setup options, as the selection popover's is, and it
  says to click Explain changes again once a provider is set up.
- **MCP: `get_user_annotations` answers when the app is not running.** Its
  description said tasks fall back to the file on disk, but with Ashlr MD
  closed the call failed and told the agent to start the app. It now reads
  the task checkboxes from the Markdown file on disk (with the same checks
  as the other disk tools), returns `verdict` and `comments` as `null`, and
  adds `appRunning: false` and a `note` saying the app keeps reviews only
  while it runs, so `null` does not mean no review was given. A file that
  cannot be read has a `tasksNote` saying why. The app and the server now
  share one task parser.
- **MCP: `edit_canvas` names the ids that exist when one is not found.** A
  mistyped or stale node or edge id came back as "node `n2` not found", with
  no word on which ids the canvas has or whether anything was written, so an
  agent had to read the file before it could retry. The error now lists the
  ids that exist at that op (the first 20, then a count) and says the file
  was left unchanged.
- **A popover action with no provider shows why on the setup panel.** When
  an action from the selection popover found no AI provider, it opened the AI
  sidebar, whose setup panel then hid the message in the chat behind it, so
  the user saw the panel and no reason; the message also said "Set one up in
  the AI sidebar" from inside that sidebar. The panel now shows the message on
  top, the message points at the panel's options, and a sidebar that still
  showed the chat switches to the panel.
- **The no-provider message is true on every platform.** With no AI
  provider, the AI sidebar's answer and the change banner's **Explain
  changes** said only "Install Ollama or add an Anthropic API key", with no
  word on the Mac's on-device model, and the README's quick start promised
  "No account, no API key" everywhere, which is untrue on Windows and Linux.
  On a Mac they now say the on-device model needs Apple Silicon, macOS 26 or
  later and Apple Intelligence turned on, then a restart; elsewhere they point
  at Ollama or an Anthropic API key. The app's two messages share one text.
- **The selection popover says when no AI provider is found.** If the
  provider went away after the AI sidebar opened (say Ollama stopped), an
  action from the selection popover opened the sidebar and stopped without a
  word. The sidebar now shows your request and the message the editors'
  inline AI gives, "No AI provider. Set one up in the AI sidebar."
- **Preferences no longer shows part of the hosted AI token.** The Hosted AI
  section showed the first 6 characters of the saved token followed by dots.
  It now says only "A token is saved.", as the Anthropic key section does.
- **Stop and Retry in the AI sidebar leave a clean chat.** Stopping before
  any text arrived left an empty "Assistant" bubble with no word that it was
  stopped; a stopped answer now shows a "Stopped" note instead (also for a
  selection popover action). Each **Retry** after a failure added your
  message to the chat again; a retry now keeps it once and replaces the
  failed answer.
- **AI errors say what to do next.** A failed request showed the provider's
  raw text in the answer, such as "Anthropic error 401 Unauthorized: {json}",
  "Ollama request failed: error sending request..." or "Hosted provider:
  invalid or expired token (401)", and that text was sent back to the model
  with the next message. The AI sidebar, the selection popover and the
  editors' inline AI now show a plain message with the next step: replace a
  wrong or expired key or token in Preferences, start Ollama with
  `ollama serve` (or pull a model), check the internet connection, or wait out
  a rate limit. The raw text stays one click away under **Details** (a tooltip
  in the editors) and is no longer part of the chat history.
- **A saved Anthropic key can be replaced or removed.** The key could only be
  entered in the AI sidebar's setup nudge, which shows only when no provider
  is found, so once saved it could not be changed. Preferences now has an
  **Anthropic API key** section to add, replace or remove it, stored in the
  OS keychain as before; it says only whether a key is saved and never shows
  any of it. The next request uses the new key, and removing it moves the
  sidebar off the Anthropic tier.
- **An IME Escape no longer cancels an inline AI rewrite in the source
  editor.** Pressing Escape to end an input-method composition (or close its
  candidate list) while a ⌘I rewrite was streaming cancelled the rewrite and
  restored the original text. The source editor now uses the same
  composition check as the WYSIWYG editor; a plain Escape still cancels.
- **On a Mac, the AI sidebar says why the on-device model is missing.** With
  no AI provider, the sidebar offered only Ollama and an Anthropic key, though
  the README promises a zero-install on-device model on macOS 26+. On a Mac
  it now says that model needs Apple Silicon, macOS 26 or later and Apple
  Intelligence turned on in System Settings, then a restart of Ashlr MD.
- **Stop in the AI sidebar stops a selection action.** When an action from
  the selection popover (Explain, Rewrite, Summarize, Translate) was
  streaming its answer into the AI sidebar, the sidebar showed **Stop**, but
  clicking it did nothing: the popover kept the request's abort handle to
  itself. Stop now ends that request too.
- **A missing home directory says what to set.** When the home directory
  could not be found, **Connect to Cursor**, **Auto-open agent Markdown** and
  `mdopener-mcp` (reaching the app or saving a conversation) said "Cannot
  determine home directory" and nothing more. They now say to set `HOME` to
  your home folder (on Windows, to check the user profile folder) and to
  restart Ashlr MD or the agent that runs `mdopener-mcp`.
- **docs/AGENTS.md says what re-running Connect to Claude Code does.** It
  said re-running Connect when the server already exists "is treated as
  success". The Claude Code section now says Connect asks `claude mcp get`
  which program the registration runs, repoints one whose program no longer
  exists, and keeps one that runs another program with a message naming the
  remove command. A doc-facts test checks it against agent_setup.rs.
- **An unreadable client config says what to check.** When **Connect to
  Cursor** or **Auto-open agent Markdown** could not read or write
  `~/.cursor/mcp.json` or `~/.claude/settings.json`, the message was the OS
  error alone ("Cannot read <path>: Is a directory"). It now says an
  unreadable file was not changed and to check that it is a text file you
  can read (or that you can write to it and its folder), then try again.
- **A disabled Connect button says how to enable it.** When Claude Code,
  Cursor or Codex was not detected, its button was disabled with only a
  tooltip, "Claude Code CLI not found", "Cursor not detected" or "Codex CLI
  not found". The tooltip and a note under the buttons now say how to
  install the tool and to reopen Preferences, which detects it again.
- **docs/AGENTS.md names the hook button the app shows.** It told readers
  to click **Install auto-open hook**, a button Preferences does not have;
  the button is **Auto-open agent Markdown**. A doc-facts test now checks
  every one-click button docs/AGENTS.md names against the Settings section.
- **A stream edit for another document names the next step.** When the
  window answered a `stream_edit` or `stream_edit_apply` whose `path` was not
  the open document, it said "Path mismatch: '...' is not the currently open
  document." and stopped. It now ends "Open it first with open_file.", as
  the app's own path check already did.
- **Connecting an agent from the AppImage registers a path that lasts.**
  An AppImage mounts itself at a new `/tmp/.mount_*` directory on every
  launch, and the **Connect** buttons, the **Copy** command, **Auto-open
  agent Markdown** and **Install mdopen** all registered the `mdopener-mcp`
  or `mdopen` inside that mount, which was gone once the app quit. When
  `$APPIMAGE` is set on Linux they now copy the binary to
  `~/.local/share/app.mdopener.desktop/bin/` and register the copy,
  rewriting it when the app's version or the bundled binary changes.
  docs/AGENTS.md says so and keeps the manual extract steps only for
  registering the server without the app.
- **A headless `export` from Edit view tells the agent how to fix it.** An
  `export` with `output_path` while the document was in Edit or Source view
  failed with "Switch to Read view before exporting.", the app's message for
  the human, naming a toggle the agent cannot click. The agent is now told
  to call `open_file` with the document's path and `mode: "read"`, then
  retry, and the `export` description and docs/AGENTS.md row say so.
- **A window that does not answer says what to do next.** When the window
  gave no answer within 4 s, `edit_document`, `stream_edit`,
  `stream_edit_apply`, `set_content`, `replace_document`, `open_file`,
  `present_document` and `request_review` (opening its file) ended on a
  question ("Is a document open?", "Is the window responsive?"), and none
  said that the change might still land. They now say the window did not
  answer within 4 s and, for a change, that the window may still apply it,
  so call `get_current_content` to see whether it did before retrying
  (retrying blindly could apply an edit twice); for an open or a preview, to
  retry once the window responds.
- **`stream_edit` and `stream_edit_apply` with no document open say so.**
  With the welcome screen showing, both answered "`find` string not found in
  the document.", so an agent went looking for its text instead of opening a
  file, the case `edit_document` already fixed. They now answer "No document
  is open in Ashlr MD; open one first (open_file).", nothing is applied or
  saved, and both tool descriptions and docs/AGENTS.md rows state the case.
- **The agent guide gives an AppImage a server path that lasts.** For an
  AppImage, docs/AGENTS.md said to register the MCP server from "the resource
  dir inside the mount", but the AppImage mounts at a new `/tmp/.mount_*`
  directory on every launch and unmounts when it quits, so that registration
  breaks as soon as the app closes. The in-app Connect, Copy and Install
  auto-open hook buttons register that same in-mount path. The guide now
  copies `mdopener-mcp` out of the AppImage once (`--appimage-extract`) into
  `~/.local/bin` and registers the copy, says the buttons use the in-mount
  path, and tells hook users to point the hook at the `mdopen` that
  **Install mdopen** copies out. A doc facts test checks the steps against
  `productName` and the Linux resource map.
- **The release runbook names what the bundler writes and what to publish.**
  docs/RELEASING.md said the workflow produces `Ashlr_MD_X.Y.Z_amd64.deb` and
  the like, but the Tauri bundler writes `Ashlr MD_X.Y.Z_amd64.deb` and
  `Ashlr MD-X.Y.Z-1.x86_64.rpm` (space included), the workflow uploads them
  as built, and the `.rpm` was not listed at all. The published `Ashlr_MD_`
  names the install guide and packaging templates download come from renaming
  the files by hand, a step the runbook never gave; uploaded as built, GitHub
  turns the space into a `.` and every link 404s. The runbook now lists both
  names for each bundle and says to rename before attaching, and a doc facts
  test ties both to `productName` and to `release.yml`.
- **The uninstall table has a `.rpm` row.** The install guide documents the
  Fedora / RHEL `.rpm` but said only how to remove the `.deb`. It now gives
  `sudo dnf remove ashlr-md`, the package name Tauri writes into the `.rpm`
  (checked against a built package), and a test fails when the row is gone.
- **The README quick start says how to get `mdopen`.** Step 2 said to run
  `mdopen notes.md`, but no app installer puts `mdopen` on `PATH`, so a new
  user got "command not found". It now names **Install mdopen** first, and
  a doc facts test fails when the step drops it.
- **`mdopener-mcp --help` says how to register the server.** It ended
  "see docs/AGENTS.md", a file an installed server has nowhere near it,
  and the hint printed when it is run by hand in a terminal said the same.
  `--help` now shows a `claude mcp add` command and the in-app Connect
  button, and both name the published guide's URL.
- **The VS Code and Obsidian READMEs link the download to GitHub
  Releases.** Their "download here" links went to md.ashlr.ai, the landing
  page, while the README, the install guide and the landing page's own
  Download button go to GitHub Releases, where the installers are. A doc
  facts test now fails when a download link points anywhere else.
- **`edit_document` with no document open says so.** The window applied
  the edit to the empty welcome buffer and answered "`find` string not
  found in the current document.", so an agent went looking for its text
  instead of opening a file. It now answers "No document is open in Ashlr
  MD; open one first (open_file).", as `set_content` does, and the tool
  description and docs/AGENTS.md row state the case.
- **`tools/list` names the destructive tools last.** `set_content`, which
  replaces the whole document, was listed third, ahead of `edit_document`,
  so an agent reading the list top down met it first. `replace_document`
  and `set_content` now come after every other tool, the docs/AGENTS.md
  tool table follows the same order, and tests fail when a tool is listed
  after a destructive one or the table drifts from `tools/list`.
- **The uninstall guide lists what an uninstall leaves behind.** It named
  only the preferences folder. `~/.mdopener/` (the IPC token and the
  conversation memory agents save) stays on every platform, and a deleted
  AppImage leaves its `mdopener://` handler pointing at a missing file;
  the guide now names both, and a test fails when it drops them.
- **The install guide says where the Windows CLI and MCP server are.** The
  Linux section said where the `.deb` puts `mdopen` and that it is not on
  `PATH`; the Windows section said nothing about `mdopen.exe` or
  `mdopener-mcp.exe`. It now names their folder, says neither is on
  `PATH`, and gives **Install mdopen** and the full-path command.
- **`mdopen --help` and docs/AGENTS.md agree.** The help's exit status
  left out two ways `mdopen` exits 1 without trying the URL scheme, a file
  the running app refuses and a connection that breaks, which the guide
  named; the guide's usage block left out `-h`, and its stdin hint gave
  only Ctrl+D, which is Ctrl+Z and Enter on Windows. A test now fails when
  the help's flags differ from the ones `mdopen` accepts or the usage
  block leaves out a short flag.
- **MCP: the app-not-running error covers an app that is not installed.**
  "Ashlr MD does not appear to be running" told the agent to launch it or
  call `open_file`, which a user without the app cannot follow. It now
  also says to ask the user to install it from the releases page.
- **MCP: `present_document` and `request_review` say they need the app.**
  Both show the human something, so an agent may call one first, but
  neither starts Ashlr MD and their descriptions did not say so; the agent
  learned it only from the error. Both now say to call `open_file` first
  when the app is closed.
- **MCP: `initialize` tells an agent where to start.** It sent no
  `instructions`, so an agent saw 20 tools with no word on which to use
  first, that only `open_file` starts the app, or what to do when Ashlr MD
  is not installed. The result now carries `instructions` naming the five
  tools to start with, the install page for a missing app, and the tools
  that work on disk without it.
- **The docs name the folder the Windows installer uses.** The install
  guide and the Phantom detection paths said `%LOCALAPPDATA%\Programs\Ashlr MD\`,
  while the README, docs/AGENTS.md and the Settings copy command said
  `%LOCALAPPDATA%\Ashlr MD\`. The per-user NSIS installer installs to
  `%LOCALAPPDATA%\Ashlr MD\`, so the two docs now say that, and a test
  fails when a doc or the Settings placeholder names another folder.
- **Shortcut hints show Ctrl on Windows and Linux, and the right key.**
  Tooltips and hints (the title bar buttons, "Unsaved (⌘S to save)", the
  welcome screen, the drawer, outline and table toolbar close and format
  buttons, the AI metrics hint) hard-coded the macOS glyphs, so Windows
  and Linux saw ⌘. The AI sidebar's close button also said ⌘K, the
  command palette's shortcut, instead of ⌘L. They now come from the
  keymap's own formatter, and a test fails on a hard-coded glyph.
- **The sample documents have no em or en dashes.** `samples/showcase.md`
  and `samples/agent-plan.md`, the documents a new user opens to try the
  app, still used them. They now use commas and colons, and the dash
  check covers `samples/` too.
- **An IME Enter no longer sends a half typed AI message.** Pressing
  Enter to commit an input-method composition in the AI chat sent the
  message as typed so far, in Preferences' AI memory field it saved the
  half typed fact, and in a WYSIWYG list it continued the list. All three
  now ignore an Enter that belongs to a composition, and a test fails on
  any new raw Enter comparison outside the shared check.
- **⌘⌥F works outside the source editor on macOS.** Option changes the
  character a key types (Option+F types "ƒ"), so the app's shortcut
  matcher, which compared that character, never saw ⌘⌥F as Find and
  replace. On macOS, with Option held, a letter shortcut now also
  matches by the physical key; other platforms match as before.
- **Code comments name the Install mdopen button.** The `mdopen` and
  `install_cli` source comments still called the Preferences button
  "Install CLI tool", and the `mdopen` one gave a Windows install folder
  the app does not use. They now name **Install mdopen** and the real
  folders (`/usr/local/bin` or `~/.local/bin`, and
  `%USERPROFILE%\.local\bin` on Windows).
- **The shortcut tables list every shortcut.** The README's table and
  the landing page's grid left out ⌘⇧C (Copy as rich text) and ⌘⇧T
  (Insert table), and the landing grid also lacked find, replace,
  search, split preview, Zen mode and settings. Both now list every
  registered shortcut, and a test fails when either drifts from the
  keymap.
- **An IME Escape no longer leaves Zen mode or cancels AI work.** The
  Escape that ends an input-method composition also left Zen mode, hid
  the AI selection toolbar, cancelled editing the hosted AI token, and
  aborted a running AI rewrite in the WYSIWYG editor. All four now use the
  same composition check as the dialogs (the token field's Enter too), and
  a test fails on any new raw Escape comparison outside that check.
- **An IME Enter no longer runs a command or jumps to a match.** Pressing
  Enter to commit an input-method composition in the command palette ran
  the selected command, and in the find bar it jumped to the next match.
  Both now ignore an Enter that belongs to a composition, with the same
  check the dialogs use for Escape; a plain Enter still runs or steps.
- **MCP: an open the app did not confirm says what to do next.** When the
  app was reached but failed or did not answer in time, `open_file` said
  only that it "did not confirm opening" the file, with the IPC error. It
  now says the app may still open it, and to call `get_current_content`
  to see which document is open before calling `open_file` again, since a
  retry may open it twice.
- **MCP: a directory passed as a document is called a directory.** Giving
  `open_file`, `present_document`, `request_review` or a tool that reads a
  path a directory was refused with "only Markdown documents ... can be
  opened", which did not say what was wrong. It now says the path is a
  directory, not a file, and to pass a Markdown file in it, as `mdopen`
  does.
- **mdopen: a Markdown dotfile is refused for its dot.** `mdopen .plan.md`
  said the file "is not a Markdown document", though its extension is.
  It now says the file is a dotfile, which Ashlr MD does not open, and to
  rename it without the leading dot.
- **A missing Ashlr MD gets a next step from `mdopen` and `open_file`.**
  When the app was not running and the `mdopener://` launcher failed, the
  error ended on a question ("is Ashlr MD installed and a desktop session
  available?"), `mdopen` said only to start the app, and the MCP
  `open_file` tool gave the agent no next step at all. Both now say Ashlr
  MD may not be installed or there is no desktop session, and to start it
  (or install it from the GitHub releases page), then try again.
- **The review countdown says what it counts.** A screen reader read the
  review panel's countdown as a bare "4:59". It is now a timer labelled in
  words ("Time left to review: 4 minutes 59 seconds"), still kept out of
  live announcements so it does not speak every second.
- **An IME Escape no longer closes a dialog.** Pressing Escape to end an
  input-method composition (or close its candidate list) while typing in
  Preferences, the Export dialog, the command palette, the search panel,
  or the find bar closed it and dropped what was being typed. They now
  ignore an Escape that belongs to a composition, as the review panel
  does, through one shared check that also covers WebKit's composition
  Escape (`keyCode` 229); a plain Escape still closes.
- **mdopen: an empty IPC token says what to do.** When
  `~/.mdopener/ipc-token` was empty, `mdopen` reported only that it was
  empty. It now says Ashlr MD has not finished starting and to retry once
  it has finished launching, or restart it if the token stays empty, as
  `mdopener-mcp` does.
- **An IME Escape no longer dismisses a review.** Pressing Escape to end
  an input-method composition (or close its candidate list) while typing
  a comment in the review panel bubbled up to the panel, which recorded
  `dismissed` for the agent and dropped the comment. The panel now
  ignores an Escape that belongs to a composition; a plain Escape still
  dismisses.
- **Obsidian: a missing Ashlr MD gets the "could not launch" notice.** When
  Electron's `shell.openExternal` rejected (no app registered for
  `mdopener://`), the plugin caught it and fell back to `window.open`,
  which resolved, so its "could not launch the app" notice never showed
  and the click did nothing. The fallback is now only for when Electron
  cannot be loaded; a rejected open shows the notice. `npm run typecheck`
  also passes now (it failed on the missing `electron` types).
- **Obsidian: the edit-mode setting names the real command.** Its
  description said to use the "Open in edit mode" command, a name the
  command palette does not list; the command is "Open current note in
  Ashlr MD (edit mode)", and the description now says so. The plugin's
  pure helpers moved to `links.ts`, with `npm test` (Node's `node:test`)
  and `npm run typecheck` scripts.
- **VS Code: a failed `mdopen` fallback says why.** When the deep link did
  not open and `mdopen` ran but could not open the file, the extension
  still said to install Ashlr MD or set `ashlr-md.cliPath`, and dropped
  what `mdopen` printed. It now passes on `mdopen`'s reason (or its exit
  status). When `mdopen` cannot be run at all, the error says where Ashlr
  MD installs it (Preferences, Command-line tool, Install `mdopen`); the
  README named an "Install CLI tool" command the app does not have.
- **VS Code: an untitled Markdown file is told to save first.** The
  extension judged the file name before checking for a file on disk, and
  an untitled buffer is named `Untitled-1`, so a new Markdown document was
  told Ashlr MD opens only Markdown files. It is now told to save the file
  first, as the README says.
- **An empty IPC token says what to do next.** When
  `~/.mdopener/ipc-token` existed but was empty, every app-backed tool
  failed with `~/.mdopener/ipc-token is empty. Has Ashlr MD finished
  starting?` and no next step. It now says the app has not finished
  starting, and to retry once it has finished launching or restart Ashlr
  MD if the token stays empty, as the not-running error says to launch it.
- **`export_text` says `char_count` counts characters.** Its description
  called the field a "character count" without saying whether that meant
  bytes, and a non-ASCII document has more bytes than characters. It now
  says `char_count` is the text's length in Unicode characters, not bytes,
  which is what the tool counts.
- **Every path argument says what a relative path resolves against.**
  `open_file`'s `path` said only "Absolute or relative path", and the
  optional `path` checks of `edit_document`, `stream_edit` and
  `stream_edit_apply` said nothing, though the server resolves each
  against its own working directory (the app has another). They now say
  so, as the other path arguments did, and `open_file` adds that `opened`
  is the absolute path.
- **`diff_documents` says what its counts are.** Its description listed
  `hunks`, `added` and `removed` without saying they count change hunks
  and added and removed lines, or that identical documents return an
  empty `diff` with all three at `0`. It now says so, and that `path_a`
  and `path_b` come back absolute.
- **`edit_canvas` says what `saved` and `content` hold.** Its description
  listed them without a word on their meaning, and called each op atomic
  when the whole call is. It now says the ops apply all or nothing, that
  `content` is `null` once the file is written, and that `save: false` is
  a dry run that writes nothing and returns the would-be canvas JSON as
  `content`.
- **The app-not-running error says it once.** It read `Ashlr MD does not
  appear to be running (~/.mdopener/ipc-port not found. Is Ashlr MD
  running?). Launch it first, ...`, asking the same thing twice, and
  `open_file` repeated the question inside its own not-running message.
  The reason is now a bare fact (`~/.mdopener/ipc-port not found`), and
  the one sentence that wraps it says the app is not running and what to
  do.
- **`get_conversation_context` says which session failed and what to do.**
  A session it could not load answered `Failed to read conversation
  context: ...`, with no session named and, for an unreadable or
  unparseable session file, no next step. It now names the session and the
  file, and says to use a new `session_id` or move the file aside and call
  again; `save_conversation_message` refusing the same file says so too.
- **`edit_canvas` on an unparseable canvas names the file.** It answered
  `Canvas parse error: Invalid JSON: ...` with no path and no word on
  whether the file had been touched. It now names the absolute path, says
  the file was left unchanged because `edit_canvas` does not overwrite a
  canvas it cannot parse, and says to fix the file (a JSON object whose
  `nodes` and `edges` are arrays of objects) and call it again.
- **`mdopener-mcp --help` and `--version` no longer panic on an
  unwritable stdout.** Piped into a reader that had already closed
  (`mdopener-mcp --help | head -c1`), or written to a full disk, they
  panicked with exit `101` and a backtrace. A closed reader now exits `0`
  in silence, and any other write failure says so in one stderr line with
  exit `1`, as `mdopen` does.
- **`mdopen --help` and `--version` no longer panic on an unwritable
  stdout.** Piped into a reader that had already closed
  (`mdopen --help | head -1`), or written to a full disk, they panicked
  with exit `101` and a backtrace. A closed reader now exits `0` in
  silence, and any other write failure says so on stderr with exit `1`.
- **`search_vault` with a missing `vault` says what to do.** A `vault`
  folder that does not exist was refused with the raw OS text (`No such
  file or directory (os error 2)`). It now says the folder does not exist
  and to name an existing folder of Markdown files, or start Ashlr MD to
  search its vault; the `text://vault-search` resource says the same.
- **`edit_canvas` on a missing file names it and what to do.** It answered
  `Failed to read missing.canvas: No such file or directory (os error 2)`,
  with the path as passed and no next step. It now names the absolute path,
  says the file does not exist, and that `edit_canvas` edits an existing
  canvas and does not create one.
- **`request_review` that loses the app mid-wait names the review.** When
  Ashlr MD stopped answering while a review was being waited on, the error
  read `App unreachable during review: ...`, with no review id and no next
  step, so the agent could neither keep waiting nor tell it from a review
  never made. It now names the review and says to call `request_review`
  with that `review_id` if the app is still open, or to request a new one
  if it was closed.
- **`mdopen --hook` refuses other arguments.** `mdopen --hook extra.md`
  ignored `extra.md` in silence and read the payload from stdin, hiding a
  mistaken hook command. Any argument besides `--hook` is now a usage
  error (exit `1`, naming it on stderr; Claude Code reports a nonzero hook
  exit without blocking the tool call). `mdopen --hook` alone still exits
  `0` in silence.
- **`mdopen --hook` opens nothing when the tool failed.** A PostToolUse
  payload whose `tool_response` reported a failed `Write`, `Edit` or
  `MultiEdit` still opened the file, showing an unchanged file as if the
  agent's edit had landed. A `tool_response` with `success: false`,
  `is_error: true`, a non-empty `error`, or a `<tool_use_error>` string now
  opens nothing, silently, and the hook still exits `0`.
- **`mdopen` names the flag a misspelled one was meant to be.** An
  unknown flag was refused with only "unknown flag", so a hook command
  with `--hok` failed on every tool call with nothing to go on. A near
  miss (`--hok`, `-edit`, `--Edit`) now says which flag it was probably
  meant to be, and a file name starting with `-` (`-notes.md`) is told to
  pass it after `--`.
- **An unknown MCP argument whose value belongs to another argument points
  at that argument.** An `edit_canvas` op written as `{"op": "move_node"}`
  was refused with "Did you mean `id`?", the declared field one letter from
  `op`, when the op is named by `type`. The hint now names the declared
  field whose allowed values include the given one (`type` here, `format`
  for `export` called with `"kind": "html"`), and falls back to the nearest
  spelling otherwise.
- **The install guide describes the update prompt the app shows.** It
  said to click **Update** and offered **Help → Check for Updates**, which
  does not exist. The prompt's buttons are **Install** and **Later**, and
  the check runs a few seconds after each launch; the guide now says so,
  and that reopening the app is how to check again.
- **The README and CONTRIBUTING open a file in `tauri dev` correctly.** They
  said `bun run tauri dev -- file.md`, but the Tauri CLI hands arguments
  after the first `--` to `cargo run`, which stops with an unexpected
  argument error. The app's arguments go after a second `--`:
  `bun run tauri dev -- -- file.md`.
- **The Linux install guide's default-app commands name the real desktop
  entry.** `docs/INSTALL.md` told you to run `xdg-mime default
  app.mdopener.desktop.desktop text/markdown`, a file the `.deb` and `.rpm`
  do not install, so Markdown files never opened in Ashlr MD. It now names
  `"Ashlr MD.desktop"` (quoted, for the space) and points at **Preferences →
  Default Markdown app**. It also said `--appimage-extract-and-run` creates
  a desktop entry and icons; that flag only runs the AppImage. The guide now
  says what the AppImage does register on its first run (the `mdopener://`
  scheme) and what it does not.
- **`mdopen --hook` opens only what a write tool wrote.** It opened the
  `tool_input.file_path` of any payload, so a hand-written hook wired as
  `PreToolUse` opened the file before the tool changed it, and a broad
  matcher opened every Markdown file the agent merely read. A payload whose
  `hook_event_name` is not `PostToolUse`, or whose `tool_name` is not
  `Write`, `Edit` or `MultiEdit`, now opens nothing (still silently, exit
  `0`). The installed hook is unaffected.
- **The VS Code extension offers Ashlr MD for `.mdx` files and opens in
  edit mode on request.** Its title-bar button and command appeared only for
  files in the Markdown language mode, so an `.mdx` file (or another
  extension the app opens that VS Code shows in some other mode) had no
  button. They now also match on the file's extension. A new "Open in Ashlr
  MD (Edit Mode)" command (also Alt/Option-click on the button) and an
  `ashlr-md.openInEditMode` setting send `&mode=edit`, as the Obsidian
  plugin does.
- **The Obsidian plugin's README no longer says it is macOS only.** It said
  the `mdopener://` scheme is registered only on macOS, but the Windows
  installers and the Linux packages register it too, and an AppImage
  registers it the first time it runs. The README, the plugin description
  and a code comment now say so.
- **Every file of a multi-file open opens.** When one open named several
  files (a second launch with several paths, or several files opened from
  Finder at once) only the last opened, and the view or export a link had
  asked for the others stayed waiting, to apply to a later open of that
  file. Each file now opens in turn, the last staying active, as files
  opened at startup already did.
- **A file opened while the window starts up is no longer lost.** The window
  drained the buffer of files opened before it was ready and only then
  registered its listener for live opens, and buffering stopped at that
  drain, so a file, second launch or `mdopener://` link that arrived in
  between was neither buffered nor heard. Files are now buffered until the
  listener is registered, and the window drains the buffer once more then.
- **The VS Code extension's `mdopen` fallback reports a killed CLI.** It
  counted a `mdopen` that ended without an exit status (killed by a signal)
  as having opened the file, so no error was shown. Only exit status `0`
  counts now, and the path is passed after `--`.
- **The VS Code extension hands off only files the app opens.** It took any
  file in the Markdown language mode, or with a Markdown extension, including
  dotfiles (`.notes.md`), but the app ignores a link to a dotfile or a file
  without a Markdown extension, so nothing opened and no message said why.
  It now applies the app's rule and says so for any other file.
- **The Obsidian plugin offers Ashlr MD only for notes it opens.** "Open in
  Ashlr MD" was in the menu of every file, and its commands ran for any
  active file, but the app ignores a link to anything other than a Markdown
  document that is not a dotfile, so clicking it on a PDF, an image or a
  `.canvas` did nothing. The menu items and commands now appear only for
  `.md`, `.markdown`, `.mdown`, `.mkd` and `.mdx` notes that are not
  dotfiles, and the ribbon icon says why for any other file.
- **`mdopener://export` links open the file in Read view.** An export link
  ignored `mode` and opened the file in whatever view it was, and an export
  from Edit view fails. It now switches the file to Read view before the
  dialog opens; `mode=read` is accepted, and `mode=edit` or an unknown mode
  ignores the link with a logged reason, as an open link refuses an unknown
  mode. docs/AGENTS.md says so, and that other parameters are ignored by both
  kinds of link.
- **Files opened while the app runs no longer pile up.** Every
  `mdopener://` link, second launch and Finder open appended its path to the
  buffer of files opened before the window was ready, which the window
  drains only once at startup, so the buffer grew for as long as the app ran.
  Paths are now buffered only until the window has drained it; later ones
  open through the live event alone, as they already did.
- **`mdopener://export` links export once the file has loaded.** The link
  sent its export request as an event right after the open, so when the link
  started the app the window was not listening yet and the request was lost
  (only the file opened), and with the app running the dialog could open
  before the file had loaded. The app now keeps a link's format per file
  until the window has opened it, as it does for `mode`, and the window then
  opens the export dialog with that format.
- **`mdopen`'s exit status docs cover an app that was reached but failed.**
  docs/PHANTOM.md's exit table (which Phantom reads) and docs/AGENTS.md left
  out that `mdopen` exits `1` without trying the URL scheme when the running
  app answers with a server error, the connection breaks, or it does not
  answer within 6 s, keeping a `mdopen -` temp file; `mdopen --help` said so.
  A doc-facts test ties the 6 s in the help and both docs to the CLI's timeout.
- **`mdopener://export` links take only known formats.** A link's `format`
  was passed to the window as given, so `format=PDF` or `format=md` opened
  the export dialog with no format selected and no word of why. A format
  other than `pdf`, `docx`, `html` or `epub` now ignores the link with a
  logged reason, and docs/AGENTS.md documents the link.
- **`mdopener://open` links honour `mode`.** `&mode=edit` was documented
  (and sent by `mdopen --edit` when the app is closed, and by the Obsidian
  plugin) but never read, so the file opened in whatever view it was. The
  app now keeps a link's `mode` until the window has opened the file, also on
  a cold start, and switches to that view; a link with any other `mode` is
  ignored and logged, as `/open` refuses one.
- **`get_current_content`'s nothing-open claim is true.** Its description
  said the error matched `export_text`'s, but `export_text` and
  `export_metadata` say to pass `path` ("No document is open in Ashlr MD;
  pass `path` to read a file."), which `get_current_content` does not take.
  The description and docs/AGENTS.md now quote each message, and the export
  descriptions say their error names `path`.
- **Prompts say they take no arguments and need an open document.**
  `prompts/list` described what `summarize`, `review_plan` and
  `improve_writing` do but not that they take no arguments or that they fail
  with no document open, which docs/AGENTS.md says. Each description now says
  both, with the codes (`-32002` with no document open, `-32000` when the app
  is not running).
- **`list_ai_actions` names its result.** Its description listed what each
  action includes but not the result's shape or field names. It now gives
  `{ actions: [{ id, label, shortLabel, icon, scope, systemPrompt,
  userPromptTemplate, argument? }], count }` and says `include_prompts:
  false` leaves the two templates out; docs/AGENTS.md's row says the same.
- **`mdopener://recent-documents` names each document's fields.** Its
  description gave `{ documents, count, skipped }` but not what a document
  holds. It now gives `{ documents: [{ path, title, mtimeMs, preview }],
  count, skipped }` and says where `title` and `preview` come from.
- **`get_conversation_context` and `save_conversation_message` name their
  results.** Their descriptions said what each stores or recovers but not
  what comes back. They now give `{ sessionId, messages: [{ id, sessionId,
  role, content, citedDocs, timestampMs }], count, recentDocs }` and
  `{ ok, messageId, sessionId, role, timestampMs, dropped?, note? }`, and
  docs/AGENTS.md's row gives each message's fields.
- **`export_text` and `export_metadata` name their result fields.** Their
  descriptions listed what they extract but not the field names, and
  docs/AGENTS.md ended `export_metadata`'s shape with "…". They now give
  `{ text, word_count, char_count, path? }` and
  `{ frontmatter, headings: [{ level, text }], wikilinks,
  embedded_image_count, word_count, path? }`, with `path` absent for an
  unsaved open document.
- **`export`'s description names its results.** It said when the call
  returns but not what comes back. It now gives `{ ok, format, path, bytes }`
  for a written file and `{ ok, format, dialog: true }` for the dialog, and
  names the 30 s write limit and the one-headless-export-at-a-time refusal,
  as docs/AGENTS.md already did.
- **`stream_edit` names its result and refusals.** Its description said it
  returns diffs but not the fields, and docs/AGENTS.md gave "the app's diff
  preview". Both now give `{ ok, editId, diff, candidates, matchCount,
  applied }`, with `candidates` null for a single match and otherwise
  `[{ matchIndex, startLine, diff, rank }]`, and name the not-found,
  not-unique (with `preview: false`), wrong-`path`, timeout and busy
  refusals.
- **`set_content`, `replace_document`, `edit_document` and
  `stream_edit_apply` name their results and refusals.** Their descriptions
  said what they change but not what comes back. They now give
  `{ ok: true }`, `{ ok: true, replaced: 1 }` and
  `{ ok: true, replaced: 1, matchIndex }`, and name when each is refused:
  no document open, `find` not found or not unique, a `match_index` past the
  last occurrence, a `path` that is not the open document, a window that
  does not answer within 4 s, two edits already waiting, and a failed save
  that leaves the change applied. docs/AGENTS.md's rows give the same, and
  its quote of the not-unique error now matches the app's.
- **`stream_edit_apply`'s `match_index` declares its 32-bit maximum.** The
  schema gave only `minimum: 0`, so a client validating against it let
  `4294967296` through and the tool then answered "`match_index` is too
  large" without the bound. The schema now declares `maximum: 4294967295`
  (the app reads the index as a 32-bit unsigned integer), the description
  and docs/AGENTS.md say so, and a larger value is refused with
  "`match_index` must be at most 4294967295, got …".
- **docs/AGENTS.md puts `stream_edit`'s `applied: true` with `preview: false`.**
  The row read as if a refused `preview_lines` came back with
  `applied: true`; the sentence now follows `preview: false`, the case the
  tool sets it for, and says a preview has `applied: false`.
- **`list_recent`, `get_user_annotations` and `present_document` name their
  results.** Their descriptions said what they do but not what comes back.
  They now give `[{ path, fileName, openedAt }]` (most recent first),
  `{ path, verdict, comments, late, tasks, tasksNote? }` (with `verdict` and
  `comments` null when no review was requested) and `{ ok, path }`, and
  `present_document` names the Markdown-only and missing-file refusals.
- **`open_file`'s description names what it refuses and returns.** It said
  only "Open a Markdown file in Ashlr MD. Launches the app if it is not
  already running." It now names the Markdown extensions, the dotfile and
  missing-file refusals, and both results: `{ opened, response }` from the
  running app, or `{ opened, method: 'url-scheme' }` (with `confirmed: false`
  and a `note` when the launcher had not finished). docs/AGENTS.md's table
  gives the same shapes.
- **`request_review`'s description says a call can return pending.** It
  said the tool blocks "until they Approve or Request changes", though one
  call waits at most `wait_ms` (50 s by default) and then returns
  `{ status: 'pending', reviewId }`. It now says so, names the result
  `{ verdict, reviewId, comments }` and lists every verdict, `dismissed`,
  `timeout` and `superseded` among them.
- **`mdopen --help` names a missing file under EXIT STATUS.** Exit 1 listed
  an "unresolvable path", which did not say that a file that does not exist
  (the commonest case) is one. It now reads "a missing or unresolvable
  path", and docs/PHANTOM.md's exit-code table says the same.
- **`open_file` refuses a non-Markdown file in its own words.** It said
  "Refusing to read `path` ...: only Markdown documents ... can be read",
  though the call is an open. It now says "Refusing to open ... can be
  opened", and `present_document` and `request_review` say "present" and
  "review"; the read tools keep "Refusing to read".
- **The guides under `docs/` and the integration READMEs have no em or en
  dashes.** INSTALL, OBSIDIAN, RELEASING and VISION and the Obsidian plugin
  and VS Code extension READMEs use colons, semicolons, commas and
  parentheses instead (the RELEASING table's empty cells say "no"). The dash
  guard test now covers all Markdown under `docs/` and `integrations/`
  except a changelog.
- **`present_document` refuses a missing file itself.** A `path` that does
  not exist was sent to the app, so with the app closed the agent heard only
  "not running" and learned the path was wrong after starting it. It is now
  refused first: "Cannot present '<absolute path>': the file does not exist."
- **`mdopen` names the target of a refused link.** `notes.md` linking to
  `.env` was refused as `"notes.md" is not a Markdown document`, though its
  name is one. It now reads `"notes.md" links to /abs/.env, which is not a
  Markdown document`.
- **`mdopen` says when a file does not exist, and where it looked.** A
  missing file read `cannot resolve path "nope.md": No such file or
  directory (os error 2)`. It is now `"nope.md" does not exist (looked for
  /abs/path/nope.md)`; other resolution failures keep the OS reason.
- **`export_text`, `export_metadata` and `diff_documents` say when a file is
  missing.** A relative path to a missing file was reported as "Cannot read
  'nope.md': No such file or directory (os error 2)". The error now names the
  absolute path the server resolved and says "the file does not exist", as
  `open_file` does.
- **`get_current_content` reports no open document as an error.** With
  nothing open it returned `{ "path": null, "content": "" }` as a success,
  the same as an empty document, so an agent could not tell the two apart.
  It is now an `isError` result ("No document is open in Ashlr MD. Open one
  first (open_file)."), the one `mdopener://current` and `export_text`
  give. An unsaved document with text, or an empty saved one, is unchanged.
- **README, CONTRIBUTING, ROADMAP and SECURITY have no em or en dashes.**
  Their prose, feature lists and tables use colons, semicolons and commas
  instead, and the dash guard test now covers every top-level Markdown file
  except this changelog, whose historical entries are unchanged.
- **docs/AGENTS.md has no em or en dashes in its prose.** Headings, lists,
  the tool table and the hook and security sections now use plain
  punctuation, as the repo's style asks; ranges read "5 000 to 600 000".
- **`mdopen -- -` opens a file named `-`, and `--help` wins over `--hook`.**
  After `--`, `-` was still read as "read stdin", so a file named `-` could
  not be opened; `--` now ends option parsing for it too, and a `-` before
  any `--` still reads stdin. `mdopen --hook --help` ran the hook (reading
  stdin, printing nothing); the help now wins, on stdout with exit `0`.
- **`get_current_content` says what a null `path` and no open document mean.**
  Its description now says that `path` is `null` for an unsaved document and
  that with no document open the call succeeds with
  `{ "path": null, "content": "" }`, where `mdopener://current` and
  `export_text` report an error. The behaviour is unchanged; docs/AGENTS.md
  says the same.
- **The landing page has no em or en dashes.** Its title, meta and social
  descriptions and body copy used them; they are plain punctuation now, as
  the repo's style asks, and the dash guard test covers the page (HTML
  comments aside) so they do not return.
- **The app starts with a launch argument that is not valid UTF-8.** Such an
  argument (a file name in a legacy encoding, passed by a file manager or a
  script) made the app panic at startup, before its window opened. It is now
  skipped and named on stderr, and the other files on the command line still
  open.
- **`mdopener-mcp` starts with an argument that is not valid UTF-8.** Such an
  argument in a client config made the server panic before it read a request
  (exit `101`), so the client reported that it failed to start. It is now
  ignored and named on stderr like any unknown argument.
- **`set_content` is listed as destructive, as `replace_document` is.** Both
  send the whole new text to the app and overwrite the open document, but
  `tools/list` gave `set_content` `destructiveHint: false`, so a client that
  asks before destructive tools let it replace a document unasked. It now
  carries the same hints as `replace_document`, and its description says it
  replaces the entire content and points to `edit_document`.
- **`mdopen` says when the path is empty or a directory.** `mdopen "$FILE"`
  with an empty or blank variable answered `cannot resolve path "": No such
  file or directory`, and a directory (even one named `notes.md`) was "not a
  file". An empty or blank path is now a usage error saying the file path is
  empty, and a directory is refused as a directory; both still exit `1`.
- **`mdopen` no longer crashes on an argument that is not valid UTF-8.**
  Such an argument (a file name in another encoding) made `mdopen` panic with
  a backtrace and exit `101`, and `mdopen --hook`, which must always exit
  `0`, did the same. It is now a usage error naming the argument (exit `1`),
  and `--hook` exits `0` in silence.
- **A path of only whitespace is refused like an empty one.** `"path": " "`
  passed the `minLength: 1` check and the empty checks, and reached the file
  checks ("only Markdown documents can be read", "No such file or
  directory") or the app. A blank `path` (of `open_file`, `present_document`,
  `export_text`, `export_metadata`, `request_review`, `edit_document`,
  `stream_edit`, `stream_edit_apply`, `get_user_annotations` and
  `edit_canvas`), `path_a`, `path_b`, `vault` or `output_path` is now
  `-32602` saying the field must not be empty. Whitespace in `find`,
  `replace` and document text is still content.
- **No em or en dashes in what the app shows.** Toasts (such as "Patch not
  found: the document may have already changed."), tooltips, dialog and
  settings text, export format descriptions, the welcome screen, the AI
  sidebar hints, the status bar, the edit errors the window reports and the
  package descriptions shown in app metadata used em dashes (and two en
  dashes). They now use plain punctuation. A test parses the UI sources and
  fails on a dash in a string literal, template text or JSX text.
  The test now also covers the shell page (`index.html`), every string in
  the Tauri configs (window titles, bundle descriptions, file association
  names) and the string literals of the Rust app and its `mdopen` and
  `mdopener-mcp` binaries (dialog, menu, tray and notification text and the
  errors the window reports), outside comments and test modules. None of
  them held a dash.
- **The app saves a path cited twice in one message once.** The window's
  session writer stored a message's `citedDocs` as given, so a path cited
  twice was written twice, while `save_conversation_message` keeps it once.
  The app now keeps each path once, in the order first given, too.
- **Fields inside array items honour their declared bounds.** The argument
  check enforced `minLength`, `minimum` and `maximum` on top-level arguments
  only; inside an `edit_canvas` op they were declared but not checked there.
  An op's empty `id` or `ids` element is now refused by `tools/call` with
  `-32602` naming the field (`` `ops[0].id` must be at least 1 character
  long ``), as a top-level argument is.
- **A whitespace-only `edit_id` or canvas id is refused like an empty one.**
  `stream_edit_apply`'s `edit_id: " "` and an `edit_canvas` op `id`,
  `reorder_edges` `ids` element, `node.id`, `edge.id`, `edge.fromNode` or
  `edge.toNode` of only whitespace passed the empty checks. They are now
  `-32602` saying the field must not be empty, as an empty one is.
- **`edit_canvas` refuses an empty id before reading the file.** An op with
  `id: ""` read the canvas and came back as "node `` not found". An empty
  op `id`, `reorder_edges` `ids` element, `add_node` `node.id`, or
  `add_edge` `edge.id`, `edge.fromNode` or `edge.toNode` is now `-32602`
  saying it must not be empty, before the file is read.
- **`stream_edit_apply` refuses an empty `edit_id`.** `edit_id: ""` named no
  preview and was accepted. The schema now declares `minLength: 1` and an
  empty one is `-32602`, as an empty `path` is; leaving it out still works.
- **`edit_canvas` writes whole coordinates as integers.** `move_node` and
  `resize_node` wrote `"x": 5` as `"x": 5.0`, while JSON Canvas positions and
  sizes are integers. A whole-number `x`, `y`, `width` or `height` is now
  written as an integer; a fractional one is kept as given.
- **A path cited twice in one message is saved once.** `save_conversation_message`
  stored `cited_docs: ["a.md", "a.md"]` as given, and `get_conversation_context`
  returned the message's `citedDocs` with the path twice. Saving now keeps each
  path once, in the order first given (after relative paths are made
  absolute), and reading lists a path an older session file holds twice once.
- **No em or en dashes in what agents read.** Tool and schema descriptions
  (`edit_document`, `edit_canvas`, `stream_edit`, `export_text`,
  `present_document`), the `improve_writing` prompt, the AI action prompts,
  the not-running error ("ipc-port not found. Is Ashlr MD running?"), the
  app's edit and timeout errors, and the first line of `mdopen --help` and
  `mdopener-mcp --help` used them. They now use plain punctuation, and a test
  scans every listing, prompt and the not-running error for them.
- **`prompts/get` refuses arguments no prompt declares.** The prompts take
  none, but `arguments: { "path": "plan.md" }` was dropped in silence and
  the prompt ran on whatever document was open. A given argument is now
  `-32602` saying to open the document with `open_file` first; leaving
  `arguments` out, `null` or `{}` still works.
- **`text://vault-search` refuses a repeated parameter and a malformed
  escape.** `?q=a&q=b` searched for `b` alone, and `?q=%ZZ` (or a lone `%`)
  searched for the literal text, so the search ran on something the agent
  never meant. Both are now `-32602` naming the parameter, as a `file://`
  URI's malformed escape already is.
- **`edit_canvas` `add_edge` refuses values JSON Canvas does not allow.** An
  edge's `fromSide`/`toSide` (top, right, bottom, left), `fromEnd`/`toEnd`
  (none, arrow), `color` and `label` were written as given and reported as
  success, so `"fromSide": "nowhere"` or `"color": "red"` left an edge the
  app drew some other way. Each is now `-32602` naming the allowed values,
  as `add_node` already refuses a bad node, and the canvas is not written.
- **`edit_canvas` refuses a field its op does not use.** A `move_node` with a
  `width`, or an `edit_text` with a `label`, applied the op and ignored the
  extra field, so the call reported success for a change it never made. It
  is now `-32602` naming the field, the fields the op takes and the ops that
  use it, before the canvas is read.
- **A `file://` read with the app down says the app is not running.** The
  app lists the readable `file://` paths, so with it unreachable every read
  was answered `-32002` "Resource not in vault", as if the file were the
  problem. It is now `-32000` with the not-running message, as
  `mdopener://current` gives, and a path the app does not list says to open
  it with `open_file` first. The vault listing is also fetched once per read
  instead of twice.
- **Each message's `citedDocs` leaves out empty paths too.** Round 27 left
  empty and blank paths from older session files out of
  `get_conversation_context`'s `recentDocs`, but every message in `messages`
  still listed them in its own `citedDocs`. They are now filtered there as
  well.
- **`cited_docs` refuses a blank path.** An empty path was refused, but one
  of only spaces was stored (and, resolved against the working directory,
  became a path to a file named by those spaces). It is now `-32602` too.
- **`request_review` refuses whitespace-only inline `content`.** An empty
  `content` was refused, but one of only spaces or newlines still registered
  a review with nothing to read. It is now `-32602` "`content` must not be
  empty" too, before the app is asked.
- **`cited_docs` paths are stored absolute.** `save_conversation_message`
  described `cited_docs` as absolute paths but stored a relative one as
  given, so `recentDocs` returned a path no agent could match. A relative
  path is now resolved against the server's working directory when saved, as
  the other path arguments are.
- **`recentDocs` leaves out empty paths from older session files.** A
  session saved before `cited_docs` refused an empty path still returned it
  in `get_conversation_context`'s `recentDocs`, as the first entry when it
  was the latest citation. Empty and blank paths are now skipped when read.
- **`edit_canvas` refuses an empty `ops` before reading the canvas.** The
  list was checked only after the file was read, so a missing canvas
  answered "Failed to read" instead of naming the empty list, and the schema
  let an empty list through. The schema now declares `minItems: 1`, the
  argument check enforces it, and the file is neither read nor written.
- **`stream_edit` refuses a `preview_lines` above 20.** It was read as 20 in
  silence, and the schema declared no maximum. It is now refused with
  `-32602` naming the range, as `diff_documents` refuses a `context_lines`,
  and the schema declares `maximum: 20`.
- **Empty arguments are refused before the app is asked.** An empty inline
  `content` in `request_review` registered a review of no text; an empty
  `path` in `edit_document`, `stream_edit` and `stream_edit_apply` came back
  as "not the open document"; `export` with `output_path: ""` said "cannot
  make an empty path absolute"; and an empty path in
  `save_conversation_message`'s `cited_docs` was stored and returned in
  `recentDocs`. Each is now `-32602` saying the argument must not be empty
  (leaving an optional one out is still allowed), and the schemas declare
  `minLength: 1`.
- **`search_vault` and `diff_documents` refuse values past their limits.**
  A `search_vault` `limit` above 200 (also as `text://vault-search?...&limit=`)
  was read as 200, and a `diff_documents` `context_lines` above 10000 as
  10000, in silence. Both are now refused with `-32602` naming the range, as
  `list_recent` and `get_conversation_context` refuse a `limit`, and the
  schemas declare the maximum.
- **Inline review content is shown in the review panel.** A
  `request_review` with `content` and no path told the human an agent wanted
  a review of inline content but never showed it, so they approved or
  rejected text they had not seen. The panel now shows it as plain text.
- **`request_review` refuses a `wait_ms` or `timeout_ms` outside its
  range.** `wait_ms` was clamped to 1000 to 600000 in silence while its
  schema said `minimum: 0`, so `wait_ms: 0` still blocked for a second. Both
  are now refused outside their real ranges (`wait_ms` 1000 to 600000,
  `timeout_ms` 5000 to 600000), and the schemas say so.
- **`list_recent` and `get_conversation_context` refuse a `limit` outside 1
  to 200.** A fractional limit became the default, `0` returned an empty
  list, and a limit above 200 was clamped. They are now `-32602` naming the
  range and the default; the argument check enforces a declared `maximum`.
  The app's `/recent` clamps its `limit` to 1 to 200, as `/search` does.
- **Empty paths and required strings are refused in the tools' own words.**
  An empty `find` (`edit_document`) or `path` (`get_user_annotations`,
  `open_file`, `present_document`, `diff_documents`, `export_text`,
  `export_metadata`, `request_review`) or `search_vault` `vault` reached the
  app or the file checks, so with the app closed the agent was told to start
  it, or read "only Markdown documents can be read". Each is now `-32602`
  "must not be empty", and every required string a tool cannot use empty
  declares `minLength: 1`.
- **An empty `review_id` no longer starts a new review.** `request_review`
  read `review_id: ""` as absent and registered a new review, which replaced
  the pending one the agent meant to wait on. It is now refused.
- **Agent setup recognises this app's registrations and hook by any path.**
  Connect to Claude Code or Codex reported "already registered" while the
  registration ran an MCP binary that no longer existed (after the app was
  moved or reinstalled); such a registration is now repointed to this app.
  A registration or Claude hook that reaches this app's binary through a
  symlink (or, on macOS, a difference in case) counts as this app's, so it
  is not reported as another program and the hook is not installed twice. A
  "does not exist" error is no longer read as "already exists".
- **The auto-open hook is repointed when its `mdopen` is gone.** Install
  auto-open hook treated any entry mentioning `mdopen --hook` as installed,
  so after the app moved the hook failed on every Markdown write. A stale
  entry now points at this app's `mdopen`.
- **Connect to Cursor never wipes an `mcp.json` it cannot parse.** A file
  with a comment or a trailing comma was replaced by `{}` plus our entry,
  deleting every other configured server, and some shapes crashed the
  command. Such files are now left unchanged, with the reason.
- **`mdopen --hook` judges the file a link points to.** A written
  `.notes.md`, or a `notes.md` link to `.env` or another non-Markdown file,
  was handed to the app. The resolved file is now checked as `mdopen <file>`
  checks it, and skipped silently when it is not a Markdown document.
- **One bad byte no longer ends the MCP server.** A request line that was
  not UTF-8 shut the server down silently. It now gets `-32700` and the
  session continues.
- **`stream_edit` previews show the edited line.** A match inside a line
  previewed as the bare replacement (`+there` for `Hello world` to `Hello
  there`), and the hunk header could count more lines than it listed. The
  added lines are now the edited text and the header matches.
- **`get_conversation_context` lists `recentDocs` newest first.** The order
  changed from call to call; it is now most recently cited first, each path
  once.
- **Tool descriptions match what the tools return.** `list_ai_actions` says
  what `{arg}` is in the templates that use it (an `argument` field), and the
  `search_vault` and `text://vault-search` descriptions list every field a
  reply carries, including `vault`, `truncated`, `depthCut` and `query`.
- **Image embeds, "Apply hunk" and the semantic index never hang on a FIFO
  or read a device.** An embed checked the image's size and then read it
  whole, so a vault `pic.png` link to `/dev/zero` (which reports a size of
  0) was read until memory ran out, and a FIFO hung the read. "Apply hunk"
  read its target, and semantic indexing every library file, the same way.
  They now read regular files only, opened without blocking, and stop at
  their cap (25 MiB for an image, 16 MiB for a document).
- **Opening and searching read regular files of at most 16 MiB.** Opening a
  document (and every read the window makes through `read_markdown_file`:
  embeds, link previews, the digest) and the search panel read whatever the
  path named, whole. A FIFO named `x.md` hung the read forever, and a
  multi-gigabyte file, or a `notes.md` link to `/dev/zero`, was read into
  memory until it ran out. Both now read only regular files, opened without
  blocking, and refuse (or, for search, skip) a file larger than 16 MiB, the
  most an agent read or an IPC request takes.
- **Agent reads take the file that was checked.** Every agent read from disk
  (the MCP tools that read a path, `file://` resources, recent-document
  previews, the grep fallback, and the app's `/search` and `/annotations`)
  resolved the path, checked it was a Markdown document, and then opened it
  again, so a `notes.md` swapped for a link to `~/.ssh/id_rsa` in between, or
  the folder above it swapped for a link to another folder, was followed. On
  Unix the read now refuses a link in the file's own name (`O_NOFOLLOW`) and
  any file that is not the one the check saw (same device and inode).
- **"Apply hunk" never patches hidden files or follows a link out of the
  folder.** A diff block names its target file, and an agent writes the diff:
  one naming `.git/config` (git runs `core.fsmonitor` as a command) or `.env`
  next to the document was applied on a click. A target that is a link to a
  file outside the document's folder was read through and its patched text
  written into the folder, where agents read it. Both are now refused.
- **`edit_canvas` never writes through a symlink.** It saved with a write
  that follows symlinks, so a `.canvas` swapped for a link to `~/.bashrc`
  after the tool checked and read it had the canvas JSON written into
  `~/.bashrc`. It now writes a new temp file and renames it over the canvas,
  which replaces a link instead of following it, and keeps the file's
  permissions.
- **Saving keeps the file's permissions.** A save (or an export over an
  existing file) replaced the file with a new one in the default mode, so a
  private `0600` note became readable by every user on the machine after its
  first save, including one an agent made with `save: true`. The new file now
  takes the old one's permissions before anything is written to it.
- **Saves never write through a planted temp-file symlink.** Every app
  write (saving a document, an export, a pasted image) went to the fixed
  `<path>.mdopener.tmp` with a write that follows symlinks, so a vault (a
  cloned repository, a shared folder) shipping `notes.md.mdopener.tmp ->
  ~/.bashrc` had the next save of `notes.md` written into `~/.bashrc`. The
  temp file is now created new under a random name and never opened when
  something is already there.
- **`mdopener://` links open only Markdown documents.** Any web page or
  program can launch the URL scheme, and `mdopener://open?path=` (and
  `export`) opened whatever path it named, such as `~/.ssh/id_rsa`: the
  window showed it, `/content` handed it to agents, and a save wrote over
  it. A link now opens only an existing Markdown document that is not a
  dotfile, judged after resolving symlinks, as `/open` already required.
- **Vault search reads only Markdown documents.** The app's `/search` and
  the MCP server's grep and semantic searches read every vault file and
  recent, and recents hold whatever the human opened, so a dropped `.env`
  or a `notes.md` link to `~/.ssh/id_rsa` had its matching lines returned
  to the agent. Like every other agent read, they now read only Markdown
  documents that are not dotfiles, judged after resolving symlinks.
- **A `notifications/*` method sent with an `id` is answered.** The server
  dropped it like a notification, so a client that sent one as a request
  waited on that id forever. It is now `-32600` with the id, saying that a
  notification must not carry one; without an id it is still silent.
- **The JSON-RPC envelope is checked.** A request was served whatever its
  `jsonrpc` said (`"1.0"`, `2`), with an object, a fraction, `true` or
  `null` as its `id`, and with a string or number as its `params`. Each is
  now `-32600` Invalid Request; an `id` that is not a string or an integer
  (MCP never allows `null`) is answered with `null`, not echoed.
- **`open_file` carries tool annotations.** It was the one tool listed
  without them, and MCP clients must then assume `destructiveHint` and
  `openWorldHint` are `true`, so it read as destructive. It now states
  all four hints (not read-only, not destructive, idempotent, closed world).
- **`scripts/install.sh` falls back to `~/.local/bin` when `/usr/local/bin`
  is not writable.** An existing directory passes `mkdir -p`, so a
  root-owned `/usr/local/bin` was picked, the link failed, and the script
  still printed `mdopen → /usr/local/bin/mdopen` without trying the
  fallback. Writability and the link itself are now checked.
- **`scripts/install.sh` on Linux installs the CLI and MCP server.** Without
  `SKIP_APP_BUILD=1` it ran the full `tauri build` and then failed looking
  for a macOS `.app` bundle, before linking `mdopen` or registering the MCP
  server. Off macOS it now skips the app build, says so, and points to the
  release packages.
- **`resources/list` says when the vault's files are cut short.** The app
  lists only the newest Markdown files of a large watched folder, and the
  `file://` entries gave no sign of it, so a client read them as the whole
  vault. The result now carries `_meta["mdopener/vaultFilesTruncated"]`
  with the reason and the app's cap, as `search_vault` says `truncated`.
- **`resources/templates/list` offers the vault search.** The method was
  unknown (`-32601`), so a client that discovers parameterised resources
  through it never saw `text://vault-search`, and the bare URI that
  `resources/list` shows cannot be read without a query. It now returns the
  template `text://vault-search?q={query}`.
- **`get_user_annotations` reads a task list up to 16 MiB.** For a file
  that is not the open document, the app's `/annotations` read the file
  whole however large it was. Past 16 MiB (or for text that is not UTF-8)
  it is not read, and the reply's `tasksNote` says why `tasks` is empty.
- **`mdopen --hook` reads at most 64 MiB of stdin.** The hook read its
  payload to the end however long it was, so a runaway producer grew its
  memory without bound. Past 64 MiB it stops reading and opens nothing,
  still silently and with exit 0.
- **The app's IPC server answers a wrong method with 405.** A route it
  has, asked for with another method (`GET /open`), got the same 404 "No
  such endpoint" as a path that does not exist. It is now a 405 with an
  `Allow` header and `{"error": "/open does not take GET: use POST."}`.
- **The app's IPC server answers an unknown route in JSON.** A request for
  a route it does not have got the plain text `Not Found`, unlike every
  other error. It is now a 404 with `{"error": "No such endpoint: <method>
  <path>"}`.
- **`mdopener://recent-documents` counts the recents it leaves out.**
  Missing, oversized, dotfile and non-Markdown recents were dropped without
  a count. The reply now has `skipped: { missing, notDocument, tooLarge,
  unreadable }`.
- **`resources/list` says when it could not list the vault's files.** When
  the app could not be asked for its vault list, the `file://` entries were
  left out without a word, so a client read it as a vault with no files.
  The result now carries `_meta["mdopener/vaultFilesUnlisted"]` with the
  reason (the MCP schema allows `_meta`), and stderr logs it.
- **The app reads session files up to 16 MiB too.** The app read a
  session file whole however large it was. Like the MCP server, it now
  refuses one past 16 MiB, saying how large it is, and a write drops the
  oldest messages to stay under the cap so the file stays readable.
- **`mdopen` reads at most 64 MiB of the app's answer.** Opening a file
  through the running app read the IPC answer to its end however long it
  was, so a peer on the port that kept sending grew `mdopen`'s memory
  without bound. Past 64 MiB (the cap the MCP server already applies) the
  open fails, saying so.
- **`search_vault` says when an on-disk `vault` is too deep.** With the
  app unreachable, the walk of `vault` enters folders at most 16 levels down
  and skipped deeper ones without a word. The limit is unchanged, but the
  result now has `truncated: true`, `depthCut: true` and a `note` saying
  folders below it were not searched.
- **A vault scan says which limit cut it.** The depth limit (folders more
  than 8 levels down) shared `scanCut` with the 50,000-entry budget, so the
  Activity drawer, `/search` and `search_vault` could not say whether the
  folder was too large or too deeply nested. `scanCut` still means either;
  a new `depthCut` flag (on the scan, `/vault`, `/search` and the
  `search_vault` result) says the depth limit did, and the notices name the
  limit that applied.
- **The MCP server reads at most 64 MiB of an HTTP answer.** Answers from the
  app's IPC server and from Ollama were read to their end however long they
  were (the 5 s timeout applies to each read), so a peer that kept sending
  grew the server's memory without bound. Past 64 MiB the request now fails,
  saying so.
- **`mdopener://recent-documents` says when the app is not running.** It
  answered an empty list, the same as an app with no recents. It is now
  `-32000`, as `mdopener://current` is.
- **`mdopener://current` says when no document is open.** With nothing open
  it answered an empty document, so an agent could not tell the two apart,
  while the prompts already refused it. It is now `-32002` "No document is
  open", the prompts' error; an open empty document is still `""`.
- **`search_vault` refuses an empty query.** An empty or whitespace-only
  `query` was sent to the app, so with the app closed the agent was told to
  start it rather than that its query was empty. `query` now declares
  `minLength: 1`, which the argument check enforces for any string property,
  and a blank query is refused too: both are `-32602` before any IPC, as is a
  blank `q` for `text://vault-search`.
- **Folders too deep to scan are no longer skipped in silence.** The vault
  walk enters folders at most 8 levels down and skipped deeper ones without
  a word, so the Activity drawer, `/search` and `search_vault` presented the
  rest as the whole folder. The depth limit is unchanged, but a skipped
  folder now marks the scan as cut short (`scanCut`), so they say the list
  is the newest of the files scanned and why.
- **Session files are read up to 16 MiB.** `get_conversation_context` and
  `save_conversation_message` read the session file whole however large it
  was, and a file that could not be read answered as an empty session. A
  file past 16 MiB is now not read: getting it is `isError: true` saying how
  large it is and what to do, and saving refuses without touching it.
  Appends keep the file within 16 MiB by dropping the oldest messages, and
  the result says how many (`dropped`, `note`).
- **`mdopen -` stops at 16 MiB.** It read all of stdin into memory and then
  into a temp file, however much was piped in (`mdopen - < /dev/zero` never
  finished). Past the 16 MiB a document may be it now exits `1`, saying so,
  without writing a temp file or opening anything.
- **Documents over 16 MiB are refused, not returned whole.** `export_text`,
  `export_metadata`, `diff_documents`, `edit_canvas` and `file://` resources
  read a document from disk whole and returned it whole, so a
  multi-gigabyte `.md` went into memory and into the agent's reply. Past
  16 MiB (what the app accepts in one request) they now refuse it, saying how
  large it is; vault search and the recent-documents resource skip it.
- **`text://vault-search` refuses parameters it does not take.** A misspelt
  query parameter (`lmit=5`) was dropped and the search ran with the default,
  and any URI that merely started with `text://vault-search` was read as it.
  An unknown parameter, or a known one with no value, is now `-32602` naming
  the closest parameter, as unknown tool arguments are.
- **`search_vault`'s `limit` means the same in every mode.** The app's own
  search returned at most 200 results and turned `limit: 0` into 1, while the
  on-disk greps and semantic search returned as many as asked, up to every
  file of a 5000-file vault. Every mode now returns at most 200, and a `limit`
  below 1 is refused (`-32602`) by the tool and the `text://vault-search`
  resource.
- **A semantic fallback keeps the app's search note.** When semantic search
  was unavailable and `search_vault` fell back to the app's own search, its
  "semantic search was unavailable" note replaced the app's note, so a
  `truncated: true` result no longer said that only the newest files were
  searched. Both notes are now kept.
- **A slow export no longer turns other agent requests away.** A headless
  export waits up to 30 s for the window, in one of the two slots edits,
  opens, presents and reviews also wait in, so two exports in flight made the
  app refuse all of those as busy until they finished. Headless exports now
  have one slot of their own; a second one sent meanwhile is refused at once,
  saying another export is being written.
- **"The 200 newest files" are the folder's true newest.** Listing the watched
  folder stopped collecting at 2000 files and only then sorted by date, so in a
  bigger folder the Activity drawer and `search_vault` saw the newest of
  whichever 2000 the file system returned first. The walk now keeps the newest
  files as it goes, reads at most 50,000 directory entries, and when it stops
  there the drawer, `/search` and `search_vault` say the list is the newest of
  the files scanned.
- **The vault-cut notice states the app's own cap.** The 200-file limit lived
  in the frontend (`MAX_FILES`) but the "only its 200 most recently changed
  files were searched" notices in `/search` and `search_vault` hard-coded it.
  The frontend now sends its cap with every vault sync, `/vault` reports it as
  `limit`, and both notices quote that number (an older app that does not send
  it gets a notice with no number).
- **A badly encoded `file://` resource URI says so.** `resources/read` with
  `%ZZ`, a lone `%` or `%FF` (not UTF-8) in the path answered "Resource not
  in vault", as if the file were the problem. It is now `-32602` naming the
  bad escape.
- **A vault list cut at 200 files says so.** The app lists the watched
  folder's 200 most recently changed Markdown files, and `search_vault`
  searched only those without a word, so "no hits" read as "not in the
  folder". `search_vault` now returns `truncated: true` with a note, and the
  Activity drawer says it shows only the newest 200.
- **A non-blocking `request_review` resume returns at once.** A call with
  `review_id` and `blocking: false` still waited up to `wait_ms` (50 s by
  default) like a blocking one. It now reads the review once and returns its
  verdict, `pending`, or `timeout` once the window has closed.
- **`edit_canvas` refuses colours JSON Canvas does not allow.**
  `set_node_color` and `add_node` wrote any string as a node colour, so
  `"red"` or `"7"` was saved and the node showed without its colour. Only a
  preset `"1"`..`"6"` or a hex `#rgb` / `#rrggbb` is accepted now; anything
  else is `-32602` and the file is left as it was.
- **MCP arguments outside a schema `enum` are refused up front.** The
  argument check enforced types, `minimum` and `required` but not `enum`, so
  each tool checked its own enumerated arguments in its own words, and an
  `edit_canvas` op `type` such as `"move"` was only refused once the canvas
  file had been read. A value outside a property's `enum` (top level or an
  op field) is now `-32602` before the tool runs, listing the allowed values,
  and the test that walks `tools/list` probes every `enum`.
- **Session files the app writes are private too.** The window persisted a
  conversation session with a `0644` file in a `0755` directory, undoing the
  `0700`/`0600` that `save_conversation_message` sets. The app now makes the
  directory owner-only and writes each session file `0600`.
- **Recent files that are gone leave the list.** A recent whose file was
  deleted or moved stayed in the Recent list and in what `list_recent` gives
  agents for good, and opening it only failed. Recents are checked on launch,
  and one that fails to open because the file is not there is dropped.
- **The watched-folder list (and what `search_vault` searches) follows the
  folder.** Switching folders kept the old folder's files until the new
  listing arrived, kept them for good when it failed, and a slow listing of
  the old folder could land after the switch. The listing also asked for the
  backend's default 100 files while the list holds 200, so half of a large
  folder was never searched. Each folder now starts empty, a stale listing is
  discarded, and up to 200 files are listed.
- **The canvas view says when it cannot show part of a canvas.** Malformed
  nodes and edges, edges to a missing node, and a `nodes` or `edges` that is
  not a list were left out without a word, so a canvas written badly by an
  agent or another tool looked complete. A notice now says what is missing.
- **MCP tool schemas describe the arguments as they work.** Path arguments
  of `request_review`, `get_user_annotations`, `present_document`,
  `diff_documents`, `edit_canvas`, `export_text` and `export_metadata` said
  "Absolute path" though relative paths resolve against the server's working
  directory, and `stream_edit` / `stream_edit_apply` named the app-internal
  `mcp_stream_edit_preview` and the options `previewLines` / `matchIndex`
  instead of `preview_lines` / `match_index`.
- **`request_review` with `review_id` no longer ignores a changed review.**
  `path`, `content` and `timeout_ms` were silently ignored on a resumed call,
  so an agent that edited its plan and resent it with the old id got the
  verdict on the old text. Resending the same values still works; a value
  that differs is now refused (`-32602`) naming it. For a review the server
  did not register (after a restart) the result lists them as `ignored`.
- **`edit_canvas` checks every op field's type, and `add_node` refuses nodes
  the app drops.** A mistyped field was misreported (`"x": "5"` gave
  "`x` required") or written as given (`"color": 3`), a misspelled field
  (`colour`) was ignored, and `add_node` checked only `node.id`, so a node
  without `x` or with an unknown `type` was saved, reported as added, and
  never appeared. All are now `-32602` naming the op index and field.
- **Required MCP arguments are checked before a tool runs.** Each tool
  checked its own required arguments only when it reached them, so
  `edit_canvas` without `ops` read and parsed the canvas file first and a
  missing file hid the real mistake. The argument check now enforces every
  tool's schema `required` list (and `request_review`'s one-of), and a test
  probes every advertised schema with a missing required argument and a
  wrong-typed one, so the schema and what is enforced cannot drift apart.
- **`diff_documents` no longer calls different files identical.** Lines were
  compared without their endings, so a CRLF file against its LF copy, or a
  file against the same text without a final newline, returned `hunks: 0`
  and an empty diff. Line endings now count: a `\r` stays visible in the
  diff and a missing final newline is marked `\ No newline at end of file`,
  as `diff -u` does.
- **Conversation memory is private to its user.** `save_conversation_message`
  created `~/.mdopener/sessions` as `0755` and each session file as `0644`,
  so any local user could read an agent's actions and the human's verdicts.
  The directory is now `0700` (an existing one is tightened on the next save)
  and session files are `0600`, like the IPC token.
- **An over-long `session_id` is refused up front.** An id whose file name
  passed the file system's 255-byte limit was accepted, then saving failed
  with `File name too long (os error 36)` while reading the same id answered
  an empty session. Both conversation tools now return `-32602` when the
  encoded file name would exceed 200 bytes.
- **MCP resources do not follow a Markdown symlink out of the vault.**
  `resources/read` checked only that a `file://` path was advertised, so a
  vault `notes.md` linking to `~/.ssh/id_rsa` or `.env` was served, and the
  `mdopener://recent-documents` preview showed its first 200 characters. Both
  now apply the check the disk-reading tools use (Markdown, not a dotfile,
  after resolving symlinks): the read is refused and the recent is skipped.
- **`export_metadata` and `export_text` see front-matter after a byte order
  mark.** A file saved with a UTF-8 BOM (Notepad does this) came back with
  `frontmatter: null`, and `export_text` kept the raw `---` block in its text
  and word count. A leading BOM is now ignored.
- **Negative MCP integer arguments are refused.** The schemas declared no
  minimum and the tools read integers as unsigned, so `list_recent` with
  `"limit": -5` listed the default 10, `request_review` with
  `"timeout_ms": -1` gave the human 5 minutes, and `stream_edit_apply` with
  `"match_index": -1` applied the first occurrence. Every integer argument now
  declares a `minimum` (`0`; `1` for `get_conversation_context`'s `limit`,
  where `0` was silently raised to `1`) and a value below it returns `-32602`
  naming the argument and the minimum.
- **An unknown MCP prompt or resource says what to ask for instead.**
  `prompts/get` answered `Unknown prompt: Summarize` and `resources/read`
  with no `uri` answered `Unknown resource URI: ` with nothing after it. Both
  now name the closest prompt or URI (`summarize`, `mdopener://current`), say
  when the name or URI is missing, and list the prompts or point to
  `resources/list`.
- **`mdopener-mcp` names an argument it ignores.** Unknown command-line
  arguments are still ignored so older client configs keep working, but a
  line on stderr now names them, so a typo such as `--verison` no longer
  starts the server without a word. Stdout stays JSON-RPC only.
- **`mdopen` says what to do when it cannot open a file.** With the app not
  running and no launcher able to start it, the error was
  `no URL launcher found (...) (Ashlr MD is not running (no ...))`. It now
  names the file, what the running-app and `mdopener://` routes each hit, and
  ends with "Start Ashlr MD, then run mdopen again." The exit code is still 1.
- **MCP tools refuse arguments they do not declare or cannot use.** Every tool
  read only the arguments it knew and defaulted any of the wrong type, so a
  typo (`export_metadata` with `pth`, `list_ai_actions` with
  `include_prompt`) or a mistyped value (`"include_prompts": "no"`,
  `"limit": "5"`, a number in `cited_docs`) was silently ignored and the call
  succeeded with defaults the agent never asked for. `tools/call` now checks
  `arguments` against the tool's `inputSchema` first and returns `-32602`
  naming the argument, the arguments the tool takes and the closest match.
  `arguments` that is not an object is refused the same way; `null` still
  means not given, and `export` keeps its own `theme` message.
- **An unknown MCP tool name says what to call instead.** `Unknown tool:
  Open_File` gave no next step; it now suggests the closest tool
  (`open_file`) and points to `tools/list`. A blank `name` says so.
- **Blank `session_id` is refused.** `save_conversation_message` accepted
  `"   "` and stored it as `~/.mdopener/sessions/%20%20%20.json`; both
  conversation tools now return `-32602` for a whitespace-only id.
- **`mdopen --edit --read` is a usage error.** It opened in whichever mode
  came last and dropped the other flag without a word; it now exits 1 and
  says the flags conflict.
- **MCP `export` with `output_path` writes that file.** The app ignored
  `output_path`: it opened its save dialog (or the print dialog) while the tool
  had already returned `{ "ok": true }`, so an agent believed a file existed that
  was never written. Now html, docx and epub exports go straight to
  `output_path` with no dialog, and the tool returns `{ ok, format, path, bytes }`
  only once the new file is on disk, or `isError` after 30 seconds (the document
  must be in Read view). `output_path` must carry the format's extension, not be
  a dotfile, and sit in an existing directory; a relative path resolves against
  the server's working directory. pdf, which only prints through the system
  dialog, refuses `output_path` with -32602.
- **MCP path arguments resolve like the agent means them.**
  `get_user_annotations`, `edit_document`, `stream_edit` and `stream_edit_apply`
  sent `path` as typed, so a relative, `./`-style or symlinked path (including
  `/tmp` on macOS) never matched the canonical path the app stores:
  `get_user_annotations` returned no verdict for a file `request_review` had
  just recorded, and the edit tools refused the open document as "not the
  currently open document". They now resolve `path` against the server's
  working directory and follow symlinks first, as `open_file` and
  `request_review` already did.
- **MCP read tools no longer read arbitrary files.** `diff_documents`,
  `export_text` and `export_metadata` read their `path` straight from disk with
  no app running, so an agent could read `~/.env` or any other file through
  them. They now accept only Markdown documents (`.md`, `.markdown`, `.mdown`,
  `.mkd`, `.mdx`) that are not dotfiles, checked after resolving symlinks, and
  return an `isError` result otherwise. `edit_canvas` likewise refuses a
  `.canvas` symlink that resolves to a non-canvas file.
- **`--version` on the CLIs.** `mdopener-mcp --version` printed nothing and
  blocked serving stdio; `mdopen --version` failed with "unknown flag". Both now
  print the version and exit 0 (`mdopener-mcp --help` too).
- **Packaging templates name the real release assets.** The Homebrew cask,
  AUR PKGBUILD, winget manifest and docs/RELEASING.md used `Ashlr.MD_…` and
  `ashlr-md_…_amd64.deb`, which 404; Tauri publishes `Ashlr_MD_…`. The PKGBUILD
  and `.desktop` entry now use the installed binary `md-opener` (and icon), and
  the cask points at `Contents/Resources/mdopen`.
- **MCP `export` refuses formats the app cannot write.** Before, any `format`
  (`"xyz"`, `"PDF"`, `"md"`) was forwarded, the app wrote HTML to `output_path`
  and reported ok. The tool now accepts `pdf`, `docx`, `html` and `epub` (the
  app already exported EPUB; the schema did not list it) and returns -32602
  for anything else.
- **MCP `search_vault` says when the app is down.** With Ashlr MD closed it
  returned `{ "mode": "grep-local", "results": [] }`, which reads as "no
  matches": the local grep fallback gets its file list from the app. It now
  returns `isError: true` with the "not running" message, as the other tools
  do; the `text://vault-search` resource returns an error the same way.
- **`mdopen -- -notes.md`** opens `-notes.md`: `--` now ends flags.
- **`docs/AGENTS.md` matches the server:** 20 tools (all listed), default
  protocol `2025-06-18`, the `text://vault-search` and
  `mdopener://recent-documents` resources, and a valid Codex TOML example. A
  test keeps the tool count and default protocol in sync.
- **`mdopener-mcp` reports the app version.** `serverInfo.version` said
  `0.1.0`; it now comes from the crate version, and the `mdopener-mcp` and
  `mdopen` sidecars are versioned with the app (0.4.0). A stdio test keeps
  it equal to `tauri.conf.json`.
- **Windows: Settings looks up the bundled MCP server by its real name.** The
  sidecar lookup behind Settings' connect actions and manual copy command
  searched for `mdopener-mcp` without the `.exe` suffix, so a Windows install
  reported it as not found even though the bundle declares `mdopener-mcp.exe`.
  The lookup now uses the platform's executable suffix, and when nothing is
  found the copy command shows that platform's typical install path instead of
  the macOS one. Not yet verified on an installed Windows build.
- **Settings finds Claude Code and Codex on Windows.** Agent CLI detection
  shelled out to `which`, which stock Windows lacks, so the Connect buttons
  stayed disabled there. It now searches `PATH` in-process (with `PATHEXT` on
  Windows, so npm's `claude.cmd`/`codex.cmd` and the native `claude.exe` are
  found), and the Connect actions run the same resolved file. Not yet verified
  on an installed Windows build.
- **The auto-open hook no longer breaks on the space in "Ashlr MD".** The hook
  command wrote the `mdopen` path unquoted, so Claude Code's shell split
  `/Applications/Ashlr MD.app/...` into two words and the hook never ran. The
  path is now single-quoted, and re-running **Auto-open agent Markdown**
  repairs an unquoted entry an earlier version wrote for the same path. The
  Windows hook assumes Claude Code runs hooks through a POSIX shell (Git Bash);
  that is unverified.
- **Install mdopen on Windows looks for `mdopen.exe`.** It searched for a bare
  `mdopen` and wrote a suffixless copy. It now uses the same lookup as agent
  setup, copies `mdopen.exe` into `%USERPROFILE%\.local\bin`, and no longer
  tries `/usr/local/bin` there. That folder is not on `PATH` by default; the
  docs now say so instead of claiming the installer edits `PATH`.
- **Agent edits apply to the live document, not a stale snapshot.** An MCP
  `edit_document`/`replace_document` that arrived within ~200 ms of you typing
  used to run against a debounced mirror — it could miss just-typed text or
  clobber it. The find/replace now runs against the live document, and
  concurrent edit requests are bounded so they can't stall the agent connection.
- **Agent IPC no longer stalls under concurrent requests.** The loopback server
  now handles requests on a small worker pool, so a slow/large response (e.g. a
  big `/content` read) can't block the agent's review polling behind it. The MCP
  binary also bounds its socket *write* with a timeout, so a wedged server can't
  hang the agent's tool call.
- **Canvas:** arrowheads no longer break when two `.canvas` files are open at
  once (each canvas now uses a unique SVG marker id), and `file` nodes that point
  at a section (`note#Heading` / `#^block`) now embed just that section instead of
  the whole document.
- **Review loop:** an expiring review countdown can no longer dismiss a *newer*
  review that replaced it — dismissal is now scoped to the review it targets.
- **No more silent data loss.** Closing a tab with unsaved edits (⌘W, the ×, or
  the Close command) now asks for confirmation instead of discarding your work.
- **AI chat renders lists correctly.** Responses that mix prose and bullet lists
  no longer get the prose swallowed into the list; and an aborted/empty assistant
  turn is no longer sent back to the model (which providers like Anthropic reject).
- **Export works from any view.** Exporting (HTML/PDF/Word) from Edit or Source
  view now switches to Read first and waits for it to render, instead of silently
  failing; failures surface as a toast.
- **Find-in-document** opened from the editor no longer occasionally shows "0/0"
  on large docs — it waits for the read view to mount rather than a fixed delay.
- **Settings → Content width** stepper added (the setting existed but had no UI).
- Next/Previous-tab commands are hidden when only one tab is open; the MCP
  `export` request reports back when no document is open instead of no-op'ing.

### Internal
- Removed two unused dependencies and dead plugin exports; broken wikilinks now
  re-resolve shortly after the missing note is created instead of staying broken
  for the session.
- Split the 1,091-line `SettingsPanel.tsx` into per-section components (one file
  per preferences section, plus a shared icon set) — no behavior change, the
  panel is now a thin composition shell.

## [0.4.0] — 2026-06-06

### Agent integration & human review
- **One-click connect for your coding agent** — wire Ashlr MD into **Claude
  Code**, **Cursor**, or **Codex** from **Preferences → AI agents (MCP)** without
  touching a terminal. Each button runs the right setup (`claude mcp add`,
  merges `~/.cursor/mcp.json`, or `codex mcp add`) and is enabled only for the
  tools actually detected on your machine; for anything else, copy the exact
  command.
- **Auto-open everything your agent writes** — install the Claude Code
  `PostToolUse` hook (`mdopen --hook`) and every Markdown file Claude writes or
  edits pops into Ashlr MD for review. The hook is silent and always succeeds,
  so it never disrupts your agent's tool flow.
- **Stop-and-ask human review loop** — a new **blocking** `request_review` MCP
  tool lets an agent surface a plan, diff, or finished doc and **wait for your
  sign-off**. You **Approve**, **Request changes**, or **Dismiss** (with
  comments) in the in-app review panel, and the verdict flows straight back to
  the agent so it knows whether to proceed. Pairs naturally with
  `present_document` for a full-screen read before you decide.

### MCP server expansion
- **A real MCP server, not just a launcher** — `mdopener-mcp` now negotiates the
  protocol version (`2024-11-05` / `2025-03-26` / `2025-06-18`), and exposes
  **resources** (`resources/list` + `resources/read`, scoped to your vault and
  recents so it can't read arbitrary files), **prompts** (`summarize`,
  `review_plan`, `improve_writing`, each embedding the live document), and a
  full **tool** set.
- **New tools for agent-driven editing** — `edit_document` (exact, unique
  find/replace that refuses ambiguous or missing matches), `replace_document`
  (whole-document swap), `search_vault` (full-text search across your watched
  folder + recents), and `present_document` (open + switch to distraction-free
  full-screen reading).
- **Token-authenticated loopback IPC** — the server talks to the app over a
  `127.0.0.1` HTTP channel guarded by a per-session 32-byte token; every
  endpoint but a data-free health probe requires it, compared in constant time.

### Obsidian compatibility
- **Reads your Obsidian vault natively** — point Ashlr MD at any note and its
  wikilinks, embeds, highlights, comments, and `.canvas` files render the way
  Obsidian's Reading View shows them. No plugins, no export step.
- **Vault-aware link resolution** — Ashlr MD auto-detects your vault root by
  walking up to the nearest `.obsidian/` folder (or use a **Settings → Vault**
  override), then resolves `[[wikilinks]]` **vault-wide** instead of only
  relative to the current file — fixing links that previously broke when notes
  lived in other folders. When several notes share a name, it picks the
  **closest** match deterministically, so a link always resolves the same way.
- **Full wikilink & transclusion grammar** — `[[note#heading]]` and
  `[[#^block]]` anchors, partial transclusion of a single heading section
  (`![[note#heading]]`) or block (`![[note#^block]]`), and image embeds with
  sizing (`![[image.png|300]]`, `![[image.png|300x200]]`). Embedded images are
  read through the Rust core into an inline `data:` URL (so the webview never
  needs broad filesystem access), capped at 25 MiB each.
- **Highlights & comments** — `==highlights==` render as `<mark>`, and inline
  `%%comments%%` are hidden in the reading view, matching Obsidian. Markers
  inside code are left as literal text.
- **Round-trip & ask-your-vault** — **Open in Obsidian** hands the current note
  back to Obsidian on that exact file (`obsidian://`), and library chat can be
  grounded across your whole vault with source citations.
- **A respectful guest** — saving is **refused** if it would land inside an
  `.obsidian/` config folder; the guard checks the path textually *and* resolves
  symlinks, so your settings, themes, and plugins are never touched.

### Canvas
- **Read-only JSON Canvas viewer** — open `.canvas` files and **pan** (drag),
  **zoom** (scroll), and **Fit** to frame the board. `text`, `file` (Markdown
  card or inline image), `link`, and `group` nodes all render, with edges drawn
  as labelled, arrowed connectors using Obsidian's color presets. Read-only:
  positions and the canvas file are never written back.

### Security & docs
- **Rewritten agent guide and new Obsidian guide** — `docs/AGENTS.md` documents
  every tool, resource, prompt, the review loop, the auto-open hook, and the IPC
  trust model; `docs/OBSIDIAN.md` covers the full compatibility surface and its
  limits.
- **Documented trust model + cross-stack hardening** — the local-only,
  token-authenticated IPC design is spelled out, the `resources/read` channel is
  scoped to advertised files, and a cross-stack security audit's fixes ship in
  this release.

## [0.3.0] — 2026-06-05

### Default-app & reliability
- **The "Make default" banner now tells the truth.** Tri-state detection means
  the prompt appears **only** when Ashlr MD is definitively *not* your default
  `.md` app — never on an unknown/failed check. It re-checks on window focus so
  it self-heals after you change the setting, with **Snooze (14 days)**, **Don't
  ask again**, and a **"Show me how"** fallback. (Root cause fixed: the macOS
  set-default helper had silently stopped shipping on newer SDKs.)
- **Continue where you left off** — open tabs and the active document reopen on
  relaunch (missing files skipped, stale sessions cleared).

### Security
- **API keys now live in your OS keychain** (macOS Keychain · Windows Credential
  Manager · Linux Secret Service) instead of plaintext, migrated automatically
  and only after a confirmed write.
- **Hardened rendering** — HTML is sanitized before math runs, Mermaid SVG is
  purified, and a strict Content-Security-Policy is enforced; script, `onerror`,
  `javascript:`, and `<iframe>` injection are stripped (with regression tests).

### Reading & editing
- **Find & replace** — `⌘F` to find (edit + read views), `⌘⌥F` to replace.
- **Search across files** — `⌘⇧F` cross-file full-text search.
- **Split view (`⌘\`)** — editor + live preview with synced scroll.
- **Zen mode (`⌘⇧Z`)** — distraction-free writing.
- **Wikilinks & embeds** — `[[link]]` and `![[embed]]` resolve across your vault.
- Reading polish: word count (excludes frontmatter/code), footnote hover
  previews, breadcrumbs, copy-link-on-heading.

### Retention & AI
- **Agent Activity Digest — "while you were away"** — on launch, the on-device AI
  summarizes what changed in your watched folder since your last visit, one click
  to review. Fully local by default (Apple Foundation Models / Ollama).
- **Local AI memory — "it knows my stuff"** — a user-owned set of facts /
  preferences / projects feeds your AI chat and quick actions; view, add, or
  forget anything from the **AI memory** panel in Settings. Never leaves the device.
- **Chat with your whole library** — a **This doc / My library** toggle grounds
  answers in your recent and watched Markdown, **with source citations**.
- **Semantic search (opt-in, on-device)** — with a local embedding model
  (`ollama pull nomic-embed-text`), library chat and Related notes use semantic
  retrieval; without one, they fall back to keyword search. Nothing is sent off
  the machine.
- **Related notes** — one-click chips surface documents related to what you're
  reading.
- **Activation & notifications** — one-click "watch this folder" on recognized
  agent docs, live plan task-progress in the status bar, and native notifications
  that fire **only on real agent activity** — never on a timer.

### Deliberately avoided
- No streaks, no scheduled "come back" pings, no engagement-bait.

## [0.2.0] — 2026-06-03

### Added
- **Cross-platform support** — Ashlr MD now builds and runs on **macOS, Windows,
  and Linux** (Tauri 2). Per-OS default-`.md`-handler (Launch Services on macOS,
  `xdg-mime` on Linux, registry + Settings on Windows) and a cross-platform
  `mdopen` CLI.
- **⌘K command palette** — fuzzy, keyboard-first access to every action and your
  recent files, backed by a central command/keymap registry.
- **Agent Activity drawer (⌘B)** — watch the folder your AI agent writes to and
  new Markdown files appear live; click to open instantly.
- **Outline navigation (⌘⇧O)** — an auto table-of-contents with scrollspy.
- **Multiple documents in tabs** — open many docs at once (`⌘⇧]` / `⌘⇧[` / `⌘W`);
  the tab bar appears only when more than one is open.
- **Inline AI superpowers** — rewrite the selection in place in the editor (⌘I)
  with Rewrite / Fix grammar / Make concise / Expand, plus "Explain changes"
  when a file changes on disk.
- **Toast notifications** — clear feedback on save, export, and new agent files.
- **Packaging** — Homebrew cask, winget manifests, and Linux `.desktop` / AUR
  scaffolding; per-OS install guide (`docs/INSTALL.md`).

### Changed
- AI assistant moved to **⌘L** (⌘K is now the command palette).
- Apple Foundation Models on-device AI is correctly scoped to macOS; Ollama is
  the free local tier on Windows/Linux.
- Unified visual language (shadows, motion, focus rings) across every surface in
  all three themes.

## [0.1.0] — 2026-06-02

Initial release: instant beautiful rendering (GFM, code, Mermaid, math,
callouts), WYSIWYG + source editing, PDF/DOCX/HTML export, local-first tiered
AI, agent hand-off (`mdopen` CLI · `mdopener://` · MCP server), the macOS `.md`
default handler, and smart agent-output rendering.

[0.4.0]: https://github.com/ashlrai/ashlr-md/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.3.0
[0.2.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.2.0
[0.1.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.1.0
