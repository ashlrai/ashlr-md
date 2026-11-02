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
