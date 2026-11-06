# Integration research

Selected 8 verified open non-draft heads: #1277, #1223, #1343, #1300, #1506, #1354, #1291, #1387. Full SHA/base/function/test mappings are in BRIDGE_NOTES.md. Seven suites moved into one lintable batch file; TypeScript printer checks confirm all original statements/assertions preserved.

Current main had masked search and display-only empty-label fallback already. It lacked nearest occurrence selection when earlier replacements shrink offsets, and could repair a later identical live link. LF/CRLF regression reproduced this on main (2 failed), then passed with nearest masked search.

Worktree metadata integration-evidence contains patches, hashes, local review/comment metadata, source comparisons and command logs. No remote mutations.
