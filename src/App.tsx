import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import { detectProvider } from "./ai/registry";
import { Shell } from "./components/layout/Shell";
import { classify } from "./lib/docClassifier";
import { listenForOpenedFiles, openOpenedFiles } from "./lib/fileOpens";
import { handleGlobalKeyDown } from "./lib/globalKeys";
import { restoreSession } from "./lib/session";
import { runStartupEmbedIndex } from "./lib/startupEmbedIndex";
import { checkForUpdates } from "./lib/updater";
import { useMcpBridge } from "./mcp/bridge";
import { useActivationStore } from "./store/activationStore";
import { useAIStore } from "./store/aiStore";
import { useDigestStore } from "./store/digestStore";
import { useDocumentStore } from "./store/documentStore";
import { useRecentStore } from "./store/recentStore";
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
        await openOpenedFiles(pending, openPath);
      } else {
        const n = await restoreSession();
        if (n >= 1) {
          toast.info(
            `Reopened ${n} document${n > 1 ? "s" : ""} from your last session`,
          );
        }
      }
      // Recents whose file was deleted or moved since are dropped, so the
      // Recent list and the agents' `list_recent` only offer real files.
      void useRecentStore.getState().pruneMissing();
      // Persist the live tab set from here on — AFTER restore, so the initial
      // empty state can't clobber the saved session before it's restored.
      unsubSave = useDocumentStore.subscribe((s) => {
        useSessionStore.getState().save(
          s.tabs.map((t) => ({ path: t.path, viewMode: t.viewMode })),
          s.tabs.find((t) => t.id === s.activeId)?.path ?? null,
        );
      });
      // Listen for live opens, then open what arrived between the drain
      // above and the listener being registered.
      unlisten = await listenForOpenedFiles(openPath);
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

  // Global keyboard shortcuts, driven by the command registry (see
  // src/lib/globalKeys.ts).
  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  // React to external (on-disk) changes of the open file.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen<string>("file-changed", (e) => {
        // Re-read it, or flag it missing when it was deleted or moved: the
        // window used to show nothing, and the next save wrote it again.
        void useDocumentStore.getState().refreshFromDisk(e.payload);
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
      // Opt-in (Settings > Semantic search); the manual button always works.
      void runStartupEmbedIndex();
    }, 4000);
    return () => clearTimeout(t);
  }, []);

  // Classify the current document whenever its content changes, and store the
  // result in uiStore so the AI sidebar and renderer can consume it.
  useEffect(() => {
    const unsub = useDocumentStore.subscribe((s) => {
      const docType = classify(s.content);
      useUiStore.getState().setCurrentDocType(docType);
    });
    // Classify on mount in case a document is already open.
    useUiStore
      .getState()
      .setCurrentDocType(classify(useDocumentStore.getState().content));
    return unsub;
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
