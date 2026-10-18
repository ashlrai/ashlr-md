# Changelog

All notable changes to Ashlr MD are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.4.1] — Unreleased

### Added
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
