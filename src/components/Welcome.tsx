import { pickAndOpen } from "../lib/openFile";
import { useDocumentStore } from "../store/documentStore";
import { useRecentStore } from "../store/recentStore";

function dirOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/").replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/");
}

export function Welcome() {
  const recents = useRecentStore((s) => s.recents);
  const openPath = useDocumentStore((s) => s.openPath);

  return (
    <div className="welcome">
      <div className="welcome-mark">M</div>
      <h1>Ashlr MD</h1>
      <p>
        A fast, beautiful home for your Markdown files. Drop a <code>.md</code> here, or
        open one — it just looks right.
      </p>
      <div className="welcome-actions">
        <button className="btn-primary" type="button" onClick={() => pickAndOpen()}>
          Open a Markdown file
        </button>
      </div>

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

      <div className="welcome-hint">
        Tip: set Ashlr MD as your default — right-click any <code>.md</code> → Open With
        → Always Open With
      </div>
    </div>
  );
}
