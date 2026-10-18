import { formatShortcut } from "../lib/keymap";
import { pickAndOpen } from "../lib/openFile";
import { useDocumentStore } from "../store/documentStore";
import { useRecentStore } from "../store/recentStore";
import { useUiStore } from "../store/uiStore";

function dirOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/").replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/");
}

function OpenIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3l1.5 1.75h5.5c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25v-7.75z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WatchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Welcome() {
  const recents = useRecentStore((s) => s.recents);
  const openPath = useDocumentStore((s) => s.openPath);
  const openActivity = useUiStore((s) => s.openActivity);
  const openCommandPalette = useUiStore((s) => s.openCommandPalette);

  return (
    <div className="welcome">
      <div className="welcome-mark" aria-hidden="true">
        M
      </div>
      <h1>Ashlr MD</h1>
      <p>
        The home for your agent’s Markdown. Point Ashlr at a folder and every plan,
        diff, and doc your AI agent writes shows up here, live.
      </p>

      <div className="welcome-actions">
        <button className="btn-primary" type="button" onClick={() => openActivity()}>
          <WatchIcon />
          Watch a folder
        </button>
        <button className="btn-secondary" type="button" onClick={() => pickAndOpen()}>
          <OpenIcon />
          Open a file
        </button>
      </div>

      <ul className="welcome-values" aria-label="What you can do">
        <li>Read agent plans with live task progress</li>
        <li>Catch new docs the moment your agent writes them</li>
        <li>Ask on-device AI about any document, private by default</li>
      </ul>

      {recents.length > 0 && (
        <div className="recents">
          <div className="recents-label">Recent</div>
          <ul className="recents-list">
            {recents.map((r) => (
              <li key={r.path}>
                <button
                  type="button"
                  className="recent-item"
                  onClick={() => openPath(r.path)}
                  title={r.path}
                >
                  <span className="recent-name">{r.fileName}</span>
                  <span className="recent-dir">{dirOf(r.path)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        className="welcome-hint welcome-hint-btn"
        onClick={() => openCommandPalette()}
      >
        Press <kbd>{formatShortcut("mod+k")}</kbd> for everything: open, export, theme,
        AI
      </button>
    </div>
  );
}
