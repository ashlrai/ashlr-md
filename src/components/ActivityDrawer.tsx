// Agent Activity drawer — left-hand overlay panel (mirror of the AI sidebar).
//
// Watches a project folder and live-surfaces the Markdown files AI coding agents
// write (PLAN.md, research dumps, …) so they stop getting buried. Newest first,
// with relative timestamps, an unseen "new" pulse, and click-to-open.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import "../styles/activity-drawer.css";
import {
  type MdFileInfo,
  onActivityFile,
  unwatchDirectory,
  watchDirectory,
} from "../lib/activity";
import { formatShortcut } from "../lib/keymap";
import { useFocusOnOpen, useReturnFocus } from "../lib/useReturnFocus";
import { MAX_FILES, useActivityStore } from "../store/activityStore";
import { useDocumentStore } from "../store/documentStore";
import { isMissingFileError } from "../store/recentStore";
import { toast } from "../store/toastStore";
import { useUiStore } from "../store/uiStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Basename of an absolute path, handling both "/" and "\" separators. */
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Compact relative time, e.g. "just now", "2m ago", "3h ago", "5d ago".
 * Assumption: anything within 10s reads as "just now"; beyond a week falls back
 * to a localized date so old files stay legible.
 */
function relativeTime(mtimeMs: number, now: number): string {
  const diff = Math.max(0, now - mtimeMs);
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(mtimeMs).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 3.5h4l1.5 1.5h7.5v7.5h-13z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 2h5l3 3v9H4z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ActivityDrawer
// ---------------------------------------------------------------------------

const ACTIVITY_FOCUS = [
  ".activity-item--active",
  ".activity-item",
  ".activity-empty__cta",
] as const;

export function ActivityDrawer() {
  const open = useUiStore((s) => s.activityOpen);
  const closeActivity = useUiStore((s) => s.closeActivity);

  const watchedDir = useActivityStore((s) => s.watchedDir);
  const files = useActivityStore((s) => s.files);
  const unseen = useActivityStore((s) => s.unseen);
  const lastError = useActivityStore((s) => s.lastError);
  const truncated = useActivityStore((s) => s.truncated);
  const scanCut = useActivityStore((s) => s.scanCut);
  const depthCut = useActivityStore((s) => s.depthCut);
  const setWatchedDir = useActivityStore((s) => s.setWatchedDir);
  const loadFiles = useActivityStore((s) => s.loadFiles);
  const applyEvent = useActivityStore((s) => s.applyEvent);
  const markAllSeen = useActivityStore((s) => s.markAllSeen);
  const removeFile = useActivityStore((s) => s.removeFile);

  const openPath = useDocumentStore((s) => s.openPath);
  const panelRef = useRef<HTMLElement>(null);
  // Closed, the panel is inert: give focus back to what had it.
  useReturnFocus(open, panelRef);
  // Opened, focus the open file's entry (else the newest, else the call to
  // action, else close).
  useFocusOnOpen(open, panelRef, ACTIVITY_FOCUS);
  const activePath = useDocumentStore((s) => s.path);

  // A ticking clock so relative timestamps stay fresh while the drawer is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [open]);

  // Re-issue the watch + reload listing whenever the watched folder changes
  // (also fires on startup if a folder was persisted).
  useEffect(() => {
    if (!watchedDir) return;
    let cancelled = false;
    watchDirectory(watchedDir).catch(() => {});
    loadFiles();
    return () => {
      cancelled = true;
      void cancelled;
    };
  }, [watchedDir, loadFiles]);

  // Subscribe to live file activity for the lifetime of the component.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    onActivityFile((ev) => applyEvent(ev)).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [applyEvent]);

  // Clear the unseen badge whenever the drawer is open.
  useEffect(() => {
    if (open && unseen.length > 0) markAllSeen();
  }, [open, unseen.length, markAllSeen]);

  // Prompt for a folder, then watch it.
  const pickFolder = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    // Replace any prior watch before switching folders.
    await unwatchDirectory().catch(() => {});
    setWatchedDir(selected);
    setNow(Date.now());
  }, [setWatchedDir]);

  const handleOpen = useCallback(
    (file: MdFileInfo) => {
      // A file deleted or moved since it was listed (a removal the watcher
      // missed) is said in a toast and leaves the list; the open document
      // stays in view. Its error used to replace the document, and the entry
      // stayed.
      void openPath(file.path, { keepViewOnError: true }).then((error) => {
        if (error === null) return;
        toast.error(`Could not open ${file.name}: ${error}`);
        if (isMissingFileError(error)) removeFile(file.path);
      });
      markAllSeen();
    },
    [openPath, markAllSeen, removeFile],
  );

  return (
    <aside
      ref={panelRef}
      className={`activity-drawer${open ? " activity-drawer--open" : ""}`}
      aria-label="Agent Activity"
      // Off-screen-but-in-DOM when closed: `inert` keeps its controls out of the
      // tab order + a11y tree until opened.
      inert={!open}
    >
      {/* Header */}
      <div className="activity-drawer__header">
        <div className="activity-drawer__heading">
          <div className="activity-drawer__title">Agent Activity</div>
          {watchedDir && (
            <button
              type="button"
              className="activity-drawer__folder"
              onClick={pickFolder}
              title={`Watching ${watchedDir}. Click to change folder`}
            >
              <FolderIcon />
              <span className="activity-drawer__folder-name">
                {basename(watchedDir)}
              </span>
            </button>
          )}
        </div>
        <button
          className="activity-drawer__close"
          type="button"
          onClick={closeActivity}
          title={`Close Agent Activity (${formatShortcut("mod+b")})`}
          aria-label="Close Agent Activity"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Body */}
      {lastError ? (
        <div className="activity-empty">
          <div className="activity-empty__icon">⚠️</div>
          <p className="activity-empty__title">Couldn’t read that folder</p>
          <p className="activity-empty__body">{lastError}</p>
          <button type="button" className="activity-empty__cta" onClick={pickFolder}>
            Choose another folder…
          </button>
        </div>
      ) : !watchedDir ? (
        <div className="activity-empty">
          <div className="activity-empty__icon">📡</div>
          <p className="activity-empty__title">Watch your agent’s folder</p>
          <p className="activity-empty__body">
            Point Ashlr at the folder your AI agent writes to and new Markdown (PLAN.md,
            research dumps, notes) shows up here instantly, newest first.
          </p>
          <button type="button" className="activity-empty__cta" onClick={pickFolder}>
            Watch a folder…
          </button>
        </div>
      ) : files.length === 0 ? (
        <div className="activity-empty">
          <div className="activity-empty__icon">👀</div>
          <p className="activity-empty__title">Watching for activity</p>
          <p className="activity-empty__body">
            No Markdown yet in{" "}
            <span className="activity-empty__dir">{basename(watchedDir)}</span>. New
            files your agent writes will appear here the moment they land.
          </p>
        </div>
      ) : (
        <>
          {truncated ? (
            <p className="activity-truncated" role="note">
              {depthCut
                ? `This folder is too deeply nested to scan in full (folders more than 8 levels down are skipped), so these are the ${MAX_FILES} most recently changed of the files scanned. Agents searching it see only these.`
                : scanCut
                  ? `This folder is too large to scan in full, so these are the ${MAX_FILES} most recently changed of the files scanned. Agents searching it see only these.`
                  : `Showing the ${MAX_FILES} most recently changed files. This folder has more, and agents searching it see only these.`}
            </p>
          ) : null}
          <ul className="activity-list">
            {files.map((file) => {
              const isActive = activePath === file.path;
              const isNew = unseen.includes(file.path);
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    className={`activity-item${isActive ? " activity-item--active" : ""}`}
                    onClick={() => handleOpen(file)}
                    title={file.path}
                  >
                    <span className="activity-item__icon">
                      {isNew ? (
                        <>
                          <span
                            className="activity-item__dot"
                            aria-hidden="true"
                            title="New since you last looked"
                          />
                          <span className="visually-hidden">New: </span>
                        </>
                      ) : (
                        <DocIcon />
                      )}
                    </span>
                    <span className="activity-item__body">
                      <span className="activity-item__name">{file.name}</span>
                      <span className="activity-item__meta">
                        <span className="activity-item__dir">{basename(file.dir)}</span>
                        <span className="activity-item__sep">·</span>
                        <span className="activity-item__time">
                          {relativeTime(file.mtimeMs, now)}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}
