# Ashlr MD for Raycast

On macOS, list the 50 most recently modified Markdown files indexed by Spotlight,
search by name or path, and press Return to open one in the installed Ashlr MD app.
Like the [VS Code integration](../vscode/README.md), this uses
`mdopener://open?path=<percent-encoded-absolute-path>`; no shell handoff or app IPC credentials.

Run `bun install` in this directory, then `bun run dev` to load the local extension
into Raycast. Run `bun run typecheck`, `bun test`, and `bun run build` to validate.
Requires Raycast and Ashlr MD installed with its URL scheme registered.

“Recent” means filesystem modification time, not Ashlr MD's viewing history.
Spotlight exclusions and unindexed volumes are omitted. Deleted files, directories,
dotfiles and invalid paths are filtered. Spotlight failures show an error; an empty
index shows an empty list. Reopen the command to refresh results.

## Part of Ashlr

Phantom and its ecosystem form a fully autonomous, code-first, agent-native
software factory, run by agents with the human as a passive board member,
chasing open source RSI (recursive self improvement). Ashlr MD is the
factory's Markdown surface: where an agent hands a document to a person.
This extension opens recent Markdown files there from Raycast. The other tools are listed in
[Part of Ashlr](https://github.com/ashlrai/ashlr-md/blob/main/README.md#part-of-ashlr).

Agents maintain this extension with the rest of the repository. Phantom
(`phm improve`) and other coding agents open pull requests and merge them once
the required checks pass, under the rules in [AGENTS.md](https://github.com/ashlrai/ashlr-md/blob/main/AGENTS.md) and
the checks in [CONTRIBUTING.md](https://github.com/ashlrai/ashlr-md/blob/main/CONTRIBUTING.md#quality-gates-all-must-pass).
People contribute the same way: see
[Contribute with an agent](https://github.com/ashlrai/ashlr-md/blob/main/CONTRIBUTING.md#contribute-with-an-agent).
