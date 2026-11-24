# GitHub Copilot instructions

[AGENTS.md](AGENTS.md) is the canonical brief for every coding agent working in `ashlr-md` (Codex, Claude Code, Cursor, GitHub Copilot, Gemini CLI, Grok, Devin, Aider, Windsurf, or a local model). Read it before changing anything; it wins over this file if they ever disagree.

Quick reference (details and exceptions live in AGENTS.md and CONTRIBUTING.md):

- Toolchain: Bun
- Setup: `bun install --frozen-lockfile`
- Test: `bun run test:unit` (then `bun run test` for the full suite)
- Before opening a PR: `scripts/ci-local.sh origin/main`
- Open a focused PR against the default branch; never force-push shared branches or bypass required checks.
- Fill in the optional "Agent used" line in the PR template so maintainers can see which tools contribute.
- Never commit secrets, tokens or personal data.
