# Security Policy

Ashlr MD is a local-first desktop app: your documents stay on your machine.
The app makes three kinds of network request, listed under
[Network requests](#network-requests): a cloud AI provider you set up, an
update check after launch, and web images in a document you open. This
document describes the threat model, the protections in place, and how to
report a vulnerability.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:

- Use GitHub's **Report a vulnerability** (Security → Advisories) on the
  repository, or
- email the maintainers at the address in the repository profile.

Include reproduction steps and the affected version. We aim to acknowledge
reports within a few days.

## Threat model

The primary untrusted input is a **Markdown file you open**. A malicious `.md`
file must not be able to run code or exfiltrate secrets. Short of you
following a link, its only network reach is loading web images, which can tell an image host that the document was
opened; turn off **Load remote images** to block that (see
[Network requests](#network-requests)). The secondary sensitive asset is your
**AI provider API key**.

## Protections

### Markdown rendering (XSS)

- Raw HTML embedded in a document is parsed (`rehype-raw`) and then **sanitized**
  with `rehype-sanitize` against an allowlist schema
  (`src/lib/sanitizeSchema.ts`). `<script>`, inline event handlers (`onerror=`),
  `javascript:` URLs, `<iframe>`, and similar vectors are stripped. Regression
  tests live in `src/lib/sanitizeSchema.test.ts`.
- Sanitization runs **before** KaTeX so the math renderer's trusted, inline-
  styled output is injected after sanitization (we therefore do not have to
  allow arbitrary inline `style`).
- Mermaid runs with `securityLevel: "strict"` and its generated SVG is
  additionally scrubbed with DOMPurify before being injected.

### Secret storage

- AI provider API keys are stored in the **OS keychain** (macOS Keychain,
  Windows Credential Manager, Linux Secret Service) via the `keyring` crate,
  never in `localStorage`. See `src-tauri/src/secrets.rs` and
  `src/store/aiStore.ts`. A legacy plaintext key from an older build is migrated
  into the keychain and scrubbed from `localStorage` on first launch.
- The key is held in memory only while the app runs and is sent to the provider
  solely at generation time, from the Rust process (not the webview).

### Content Security Policy

- A CSP is enforced (`src-tauri/tauri.conf.json`). `connect-src` is restricted to
  Tauri IPC, so webview scripts cannot call the network: all HTTP, including
  AI providers, is brokered by Rust via `reqwest`. `frame-src` and `object-src`
  are `'none'`. The one exception is `img-src`, which allows `https:` so a
  document's web images can render (see below).

### Network requests

- **AI providers.** A cloud provider is called only after you add its key or
  turn on a hosted option, from the Rust process. Apple's on-device model and
  a loopback Ollama stay on the machine. See [docs/local-ai.md](docs/local-ai.md).
- **Update check.** About 3 seconds after launch, the app fetches
  `latest.json` from the repository's GitHub Releases (`src/lib/updater.ts`).
  If a newer build exists it asks before installing, and the updater verifies
  the build's minisign signature against the public key in `tauri.conf.json`.
- **Web images.** An `https://` image in a document is fetched by the webview
  when the document renders, which tells its host the document was opened.
  **Settings → Appearance → Load remote images** is on by default. Turn it off
  and web images in the read view, the editor and link previews are not
  fetched until you click **Load remote images** on that document's bar; that
  choice covers that document for the session only (`src/store/remoteImagesStore.ts`).

### Local agent IPC

- Ashlr MD runs a **loopback-only** HTTP server (`127.0.0.1`, OS-assigned port)
  so the bundled MCP binary and coding agents can drive the app. It binds to
  localhost only, never a routable interface.
- Every endpoint except `/health` requires a **per-session bearer token**: 32
  bytes of OS CSPRNG (`getrandom`) compared in constant time. The token and port
  are written to `~/.mdopener/` owner-only (`0600` on Unix; the token is written
  before the port, which is the "ready" signal) and removed on exit.
- **Trust boundary.** The token defends against *other users* on the machine and
  against anything off-box. It does **not** defend against a process running as
  *the same user*: on every OS a same-user process can read the token file and
  the agent already has filesystem/shell access of its own. We therefore treat
  same-user code as trusted: the IPC adds no capability an agent doesn't already
  have. For the same reason, file-reading commands (`read_markdown_file`,
  `read_image_data_url`) are intentionally not path-scoped; opening any file the
  user points at is the app's core function. The one write-side guard is refusing
  to write inside a vault's `.obsidian/` config dir.
- **Agent opens are Markdown-only.** Because an opened document can be read
  back over the IPC (`/content`, recents), the `/open`, `/present` and
  `/review` endpoints, the MCP tools that call them (`open_file`,
  `present_document`, `request_review` with a path) and the `mdopen` CLI refuse
  anything but an existing Markdown document (`.md`, `.markdown`, `.mdown`,
  `.mkd`, `.mdx`) that is not a dotfile, checked on the canonical path, so a
  `notes.md` symlink to `.env` is refused too. The IPC answers HTTP 400 with
  the reason, which reaches the agent as an `isError` tool result.

### Native capabilities

- Tauri capabilities are scoped (`src-tauri/capabilities/`). Shell command
  execution (`run_shell`) only runs code from the user's own document **after an
  explicit in-UI confirmation**; there is no implicit/automatic execution.

### Supply chain

- Every pull request and merge queue run must pass the required `Check (Linux)`
  gate, which includes two diff secret scans (pinned Gitleaks and the
  secret-shape scan) and a crypto policy check (`bun run check:crypto`).
- `bun audit` runs on every pull request. `cargo audit`, `cargo clippy -D
  warnings` and the full Linux and macOS test suites run after each merge to
  `main`, daily, and on manual dispatch (`.github/workflows/ci.yml`). Both
  audits are advisory: a new advisory is annotated on the run without failing
  it.

## Supported versions

Security fixes target the latest released version. Please upgrade before
reporting issues against older builds.
