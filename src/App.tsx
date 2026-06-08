import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import { detectProvider } from "./ai/registry";
import { Shell } from "./components/layout/Shell";
import { getShortcutCommands } from "./lib/commands";
import { matchShortcut } from "./lib/keymap";
import { restoreSession } from "./lib/session";
import { checkForUpdates } from "./lib/updater";
import { useMcpBridge } from "./mcp/bridge";
import { useActivationStore } from "./store/activationStore";
import { useAIStore } from "./store/aiStore";
import { useDigestStore } from "./store/digestStore";
import { useDocumentStore } from "./store/documentStore";
import { useSessionStore } from "./store/sessionStore";
import { useSettingsStore } from "./store/settingsStore";
import { toast } from "./store/toastStore";
import { useUiStore } from "./store/uiStore";
import "./styles/themes.css";
import "./styles/global.css";
import "./styles/markdown.css";
import "./styles/command-palette.css";
import "./styles/diff.css";

const MD_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;

export default function App() {
  const openPath = useDocumentStore((s) => s.openPath);
  const theme = useSettingsStore((s) => s.theme);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const contentWidth = useSettingsStore((s) => s.contentWidth);
  const [dragOver, setDragOver] = useState(false);

  // Bridge: mirror document/recents to Rust for MCP, and apply agent-driven
  // open / set-content / export events.
  useMcpBridge();

  // Apply theme + typography to the document root.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.setProperty("--content-font-size", `${fontSize}px`);
    root.style.setProperty("--content-width", `${contentWidth}px`);
  }, [theme, fontSize, contentWidth]);

  // Open files: drain anything buffered before mount; if the user didn't
  // double-click a file, restore the previous session ("continue where you left
  // off"). Then start persisting session changes and listen for live opens.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unsubSave: (() => void) | undefined;
    (async () => {
      const pending = await invoke<string[]>("take_pending_files").catch(
        () => [] as string[],
      );
      if (pending.length) {
        // Open every queued file (openPath dedupes); the last stays active.
        for (const p of pending) await openPath(p);
      } else {
        const n = await restoreSession();
        if (n >= 1) {
          toast.info(
            `Reopened ${n} document${n > 1 ? "s" : ""} from your last session`,
          );
        }
      }
      // Persist the live tab set from here on — AFTER restore, so the initial
      // empty state can't clobber the saved session before it's restored.
      unsubSave = useDocumentStore.subscribe((s) => {
        useSessionStore.getState().save(
          s.tabs.map((t) => ({ path: t.path, viewMode: t.viewMode })),
          s.tabs.find((t) => t.id === s.activeId)?.path ?? null,
        );
      });
      unlisten = await listen<string[]>("file-opened", (e) => {
        const paths = e.payload;
        if (paths.length) openPath(paths[paths.length - 1]);
      });
    })();
    return () => {
      unlisten?.();
      unsubSave?.();
    };
  }, [openPath]);

  // Native drag-and-drop of files onto the window.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over" || p.type === "enter") {
          setDragOver(true);
        } else if (p.type === "drop") {
          setDragOver(false);
          const md = p.paths.find((path) => MD_EXT.test(path)) ?? p.paths[0];
          if (md) openPath(md);
        } else {
          setDragOver(false);
        }
      });
    })();
    return () => unlisten?.();
  }, [openPath]);

  // Global keyboard shortcuts — driven entirely by the command registry so the
  // keymap is a single source of truth (see src/lib/commands.ts). Each command
  // carries its canonical shortcut string; we match the event against the live
  // list and run the first available command whose shortcut matches.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Escape leaves Zen mode first — it isn't expressible as a mod-shortcut.
      if (e.key === "Escape" && useUiStore.getState().zenMode) {
        e.preventDefault();
        useUiStore.getState().closeZen();
        return;
      }
      for (const cmd of getShortcutCommands()) {
        if (cmd.shortcut && matchShortcut(e, cmd.shortcut)) {
          if (cmd.when && !cmd.when()) return; // shortcut owned but unavailable
          e.preventDefault();
          cmd.run();
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // React to external (on-disk) changes of the open file.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen<string>("file-changed", async (e) => {
        const changedPath = e.payload;
        const current = useDocumentStore.getState();
        if (current.path !== changedPath) return;
        try {
          const file = await invoke<{ content: string }>("read_markdown_file", {
            path: changedPath,
          });
          useDocumentStore.getState().handleDiskUpdate(file.content);
        } catch {
          /* file may be mid-write; the next event will settle it */
        }
      });
    })();
    return () => unlisten?.();
  }, []);

  // Check for updates shortly after launch (no-op in dev / offline).
  useEffect(() => {
    const t = setTimeout(() => {
      checkForUpdates();
    }, 3000);
    return () => clearTimeout(t);
  }, []);

  // Load the AI API key from the OS keychain (migrating any legacy plaintext
  // key out of localStorage) so tier-2 detection works without re-entry.
  useEffect(() => {
    void useAIStore.getState().loadApiKey();
  }, []);

  // Warm AI provider detection shortly after launch so the sidebar opens
  // instantly instead of showing a "Detecting…" wall (results are cached).
  useEffect(() => {
    const t = setTimeout(() => {
      void detectProvider().then((p) => {
        useAIStore.getState().setProvider(p.id, p.capabilities);
      });
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  // Build/refresh the on-device semantic index in the background — a no-op when
  // no embed model is installed. Incremental: only changed files are re-embedded.
  useEffect(() => {
    const t = setTimeout(() => {
      void (async () => {
        const { embedAvailable, embedIndex } = await import("./lib/embedSearch");
        if (!(await embedAvailable())) return;
        const { useRecentStore } = await import("./store/recentStore");
        const { useActivityStore } = await import("./store/activityStore");
        // Ensure the watched-folder file list is populated before indexing.
        await useActivityStore.getState().loadFiles();
        const paths = new Set<string>();
        for (const r of useRecentStore.getState().recents) paths.add(r.path);
        for (const f of useActivityStore.getState().files) paths.add(f.path);
        // Full reindex (prune stale files) since this is the complete library.
        if (paths.size > 0) void embedIndex(Array.from(paths), true);
      })();
    }, 4000);
    return () => clearTimeout(t);
  }, []);

  // Activation bookkeeping + the "while you were away" Agent Activity Digest.
  // touchLastSeen returns the PRIOR launch time; if there's a prior session and
  // a watched folder, summarize what changed since then.
  useEffect(() => {
    const a = useActivationStore.getState();
    a.markFirstRun();
    const prev = a.touchLastSeen();
    if (prev != null) {
      void useDigestStore.getState().generate(prev);
    }
  }, []);

  return <Shell dragOver={dragOver} />;
}
