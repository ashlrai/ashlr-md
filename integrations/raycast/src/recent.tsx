import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useEffect, useState } from "react";
import { buildDeepLink, parsePaths } from "./deeplink";

const execute = promisify(execFile);
const query = ["md", "markdown", "mdown", "mkd", "mdx"]
  .map((ext) => `kMDItemFSName == '*.${ext}'cd`).join(" || ");

async function recentFiles(): Promise<string[]> {
  const { stdout } = await execute("/usr/bin/mdfind", ["-0", query], {
    timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
  const entries = await Promise.all(parsePaths(stdout).map(async (path) => {
    try {
      const info = await stat(path);
      return info.isFile() ? { path, time: info.mtimeMs } : undefined;
    } catch { return undefined; } // Omit files removed since Spotlight indexed them.
  }));
  return entries.filter((entry) => entry !== undefined)
    .sort((a, b) => b.time - a.time).slice(0, 50).map((entry) => entry.path);
}

export default function Command() {
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    recentFiles().then((files) => { if (active) setPaths(files); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <List isLoading={loading} searchBarPlaceholder="Search recent Markdown files">
    <List.EmptyView title={error ? "Could not read Spotlight results" : "No Markdown files found"}
      description={error ? "Check Spotlight is enabled, then reopen this command." : "Only Spotlight-indexed Markdown files appear here."} />
    {paths.map((path) => <List.Item key={path} icon={Icon.Document} title={basename(path)}
      subtitle={path} keywords={[path]} actions={<ActionPanel>
        <Action.OpenInBrowser title="Open in Ashlr MD" url={buildDeepLink(path)} />
      </ActionPanel>} />)}
  </List>;
}
