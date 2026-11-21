# Ashlr MD for Raycast

Find a recently modified Markdown file from [Raycast](https://www.raycast.com)
and open it in **[Ashlr MD](https://md.ashlr.ai)** with one keystroke.

> **macOS only.** Raycast runs on macOS, and the extension reads Spotlight's
> index. Ashlr MD must be installed so its `mdopener://` URL scheme is
> registered.

## What it does

| Step | What happens |
|---|---|
| Run **Open Recent Markdown** | Lists the 50 most recently modified Markdown files that Spotlight has indexed, newest first |
| Type in the search bar | Filters the list by file name or full path |
| Press Return (**Open in Ashlr MD**) | Opens the file in the installed Ashlr MD app |

A Markdown file is one ending in `.md`, `.markdown`, `.mdown`, `.mkd` or
`.mdx`, in any letter case: the same list the desktop app accepts. Like the
[VS Code](../vscode/README.md) and [Obsidian](../obsidian/README.md)
integrations, the extension opens
`mdopener://open?path=<percent-encoded-absolute-path>`. It starts no shell,
uses no app IPC credentials, and sends nothing over the network.

## Requirements

- macOS with [Raycast](https://www.raycast.com) installed
- Ashlr MD installed: [download here](https://github.com/ashlrai/ashlr-md/releases/latest)
- Spotlight indexing turned on for the folders you want listed

## Build and test

Load the extension from a clone of this repository with [Bun](https://bun.sh):

```bash
cd integrations/raycast
bun install
bun run dev        # ray develop: loads the extension into Raycast
bun run test       # the path and deep-link helpers in src/deeplink.ts
bun run typecheck  # tsc --noEmit
bun run build      # ray build: validates and builds the extension
```

There is no committed lockfile, so `bun install` resolves the newest versions
the `package.json` ranges allow and writes a `bun.lock` that git shows as
untracked. Leave it out of your commit unless the change is meant to pin
dependencies. No CI job builds or tests this extension, so run these commands
after changing it (they are also listed in
[CONTRIBUTING.md](../../CONTRIBUTING.md#quality-gates-all-must-pass)).

## Caveats

- "Recent" means file modification time, not Ashlr MD's viewing history.
- Files Spotlight has not indexed are missing: excluded folders (System
  Settings → Spotlight), unindexed volumes, and files created since the last
  index update.
- Deleted files, directories, dotfiles (a name starting with `.`), relative
  paths and paths with `.` or `..` segments are dropped before listing.
- The list is read once when the command opens. Reopen the command to refresh
  it.
- If Spotlight fails, takes longer than 10 seconds, or returns more than 4 MiB
  of paths, the command shows "Could not read Spotlight results". An empty
  index shows "No Markdown files found".

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
