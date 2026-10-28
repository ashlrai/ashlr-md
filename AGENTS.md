# AGENTS.md: agent constitution

This repository is part of the AshlrAI ecosystem. It is maintained by Phantom (`phm improve` / steward) and other coding agents, under the same standing authority that applies to `ashlrai/phantom` (see phantom `docs/STANDING-AUTHORITY.md`).

## Agents may
- Create branches, commit, and open pull requests.
- Turn on GitHub auto-merge (`phm improve --auto-merge` / `gh pr merge --auto`). A PR merges only after every required CI check is green. Never bypass a failing or pending check, and never use an admin override.
- Fix CI, tests, docs, and dependencies, and iterate on review feedback.

## Reserved for Mason (owner approval required)
- Creating, moving, or deleting release tags, and publishing packages or releases.
- Rotating, creating, or exposing secrets and tokens.
- Deleting repositories, branches, or data, and changing rulesets or branch protection.
- Spending money, or anything that is billed.
- Outside messages: emails, posts, issues, or comments directed at people outside AshlrAI.

## Ground rules
- Keep diffs small and reviewable, with one concern per PR.
- Never commit secrets. Use Phantom Secrets placeholders.
- Never force-push to the default branch.

## Documentation freshness
- The user-facing agent guide is [docs/AGENTS.md](docs/AGENTS.md).
- MCP tool names and order come from `tool_registry()` in
  `src-tauri/bins/mdopener-mcp/src/lib.rs`; CLI usage comes from `HELP` in `main.rs`
  in the same directory. Frontend event handlers live in `src/mcp/handlers/`.
- After changing those surfaces, update the guide and run
  `python3 scripts/check-docs.py` to catch missing, removed or reordered entries.
