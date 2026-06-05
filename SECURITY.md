# Security Policy

Ashlr MD is a local-first desktop app: your documents stay on your machine and
nothing is sent to a network unless you explicitly invoke a cloud AI provider.
This document describes the threat model, the protections in place, and how to
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
file must not be able to run code, exfiltrate secrets, or reach the network. The
secondary sensitive asset is your **AI provider API key**.

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
  Windows Credential Manager, Linux Secret Service) via the `keyring` crate —
  never in `localStorage`. See `src-tauri/src/secrets.rs` and
  `src/store/aiStore.ts`. A legacy plaintext key from an older build is migrated
  into the keychain and scrubbed from `localStorage` on first launch.
- The key is held in memory only while the app runs and is sent to the provider
  solely at generation time, from the Rust process (not the webview).

### Content Security Policy

- A CSP is enforced (`src-tauri/tauri.conf.json`). `connect-src` is restricted to
  Tauri IPC; the webview never makes direct outbound network requests (all HTTP,
  including AI providers, is brokered by Rust via `reqwest`).

### Native capabilities

- Tauri capabilities are scoped (`src-tauri/capabilities/`). Shell command
  execution (`run_shell`) only runs code from the user's own document **after an
  explicit in-UI confirmation** — there is no implicit/automatic execution.

### Supply chain

- CI runs `bun audit` and `cargo audit` to surface known-vulnerable
  dependencies, plus `cargo clippy -D warnings` and the full test suite on every
  push and pull request.

## Supported versions

Security fixes target the latest released version. Please upgrade before
reporting issues against older builds.
