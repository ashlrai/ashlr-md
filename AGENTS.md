# AGENTS.md: agent constitution

This repository is part of the AshlrAI ecosystem. It is maintained by Phantom (`phm improve` / steward) and other coding agents, under the same standing authority that applies to `ashlrai/phantom` (see phantom `docs/STANDING-AUTHORITY.md`).

## Article 1: Full autonomy, always forward

Synced from the Ashlr Fleet Constitution v3.0 (Nov 1, 2026). This overrides any older text in this file.

**Full autonomy, always forward (Mason t1287u, Nov 1 2026 11:47 PM ET).** Every agent may merge PRs to main and push to production (releases through each repo's sanctioned workflow, any agent may dispatch them). Take the human out of the loop; let nothing slow us down; do the highest-leverage, most ambitious work. No approval, manual-merge, wait-for-per-PR-CI or ask-Mason steps. Mason is needed only for passwords, 2FA, device approvals and payments. The only kept limits are Security GATES v3, the hold list below, and making private things public. Any new gate must be justified against this article or it is rejected.

### Hard floor (the only fixed rules)
- Security GATES v3: pins only on the secret gate (scrub.pl, secret-shape gate, publish.sh), sandbox profiles and leader wrappers/prompts/plists, secret-leaking workflow diffs, and the MACCU TCC helper plus loopback auth. No force-push to default branches, no ruleset or admin bypass, no ~/.codex auth changes, no billing changes, no secret values in logs.
- Merge-queue required checks stay where a repo has them; full CI daily; main-guardian fixes main forward.
- Fork-only pushes through publish.sh. Local models loopback-only.
- Mason only for passwords, 2FA, device approvals and payments (no new spending without him). Nothing private made public.
- Hold list (Mason's own holds): phantom #197 #878 #743 #725 #738 #744 #693 #1228; phantom-secrets #140 #197 #375 #168 #418 #136; ashlr-plugin #152 #157.

## Agents may
- Create branches, commit, and open pull requests.
- Turn on GitHub auto-merge (`phm improve --auto-merge` / `gh pr merge --auto`). Merge to main and ship to production on your own, with no human approval or manual merge; fix main forward. Never use an admin override.
- Fix CI, tests, docs, and dependencies, and iterate on review feedback.

## Kept limits (Article 1)
- Rotating, creating, or exposing secrets and tokens; no secret values in logs or chat.
- Force-pushing to the default branch, ruleset or admin bypass, or deleting repositories.
- Spending money, billing, or paid-plan changes (needs Mason).
- Outside messages: emails, posts, issues, or comments directed at people outside AshlrAI.
- Releases and publishes run through each repo's sanctioned release workflow, which any agent may dispatch.

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
- After moving or renaming docs or headings, run `bun run check:doc-links`:
  it fails on any relative link or `#anchor` in the repository's Markdown that
  points nowhere (`--external` also probes remote URLs).
