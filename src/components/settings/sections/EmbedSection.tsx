import { useEffect, useState } from "react";
import {
  type EmbedStatus,
  embedIndex,
  embedStatus,
  invalidateEmbedAvailable,
} from "../../../lib/embedSearch";
import { useActivityStore } from "../../../store/activityStore";
import { useRecentStore } from "../../../store/recentStore";
import { SpinnerIcon } from "../icons";

/** On-device semantic search status + manual reindex. */
export function EmbedSection() {
  const [status, setStatus] = useState<EmbedStatus | null>(null);
  const [indexing, setIndexing] = useState(false);

  useEffect(() => {
    embedStatus().then(setStatus);
  }, []);

  async function reindex() {
    setIndexing(true);
    try {
      invalidateEmbedAvailable(); // a model may have just been pulled
      const paths = new Set<string>();
      for (const r of useRecentStore.getState().recents) paths.add(r.path);
      for (const f of useActivityStore.getState().files) paths.add(f.path);
      await embedIndex(Array.from(paths), true); // full reindex — prune stale files
      setStatus(await embedStatus());
    } finally {
      setIndexing(false);
    }
  }

  if (!status) {
    return <p className="settings-description settings-description-muted">Checking…</p>;
  }

  if (!status.available) {
    return (
      <p className="settings-description settings-description-muted">
        Semantic search needs a local embedding model. Run{" "}
        <code className="settings-inline-code">ollama pull nomic-embed-text</code> to
        upgrade your “My library” chat answers from keyword to semantic — fully
        on-device.
      </p>
    );
  }

  return (
    <div className="settings-cli">
      <p className="settings-description">
        “My library” chat answers are grounded in semantic search over your Markdown,
        fully on-device via <code className="settings-inline-code">{status.model}</code>
        .
      </p>
      <div className="settings-cli-row">
        <button
          type="button"
          className="settings-action-btn"
          onClick={reindex}
          disabled={indexing}
          aria-busy={indexing}
        >
          {indexing && <SpinnerIcon />}
          {indexing ? "Indexing…" : "Reindex library"}
        </button>
        <span className="settings-cli-result settings-description-muted">
          {status.chunkCount} chunks · {status.fileCount} files
        </span>
      </div>
    </div>
  );
}
