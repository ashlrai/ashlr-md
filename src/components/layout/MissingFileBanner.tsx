import { useDocumentStore } from "../../store/documentStore";

/**
 * Shown when the open file was deleted or moved outside the app. The text
 * stays in the window; nothing is written until the user picks Save As or
 * Recreate (a plain save asks first).
 */
export function MissingFileBanner() {
  const fileName = useDocumentStore((s) => s.fileName);
  const save = useDocumentStore((s) => s.save);
  const saveAs = useDocumentStore((s) => s.saveAs);

  return (
    <div className="change-banner" role="alert">
      <span className="change-banner-text">
        “{fileName}” was deleted or moved outside Ashlr MD. Your text is still here.
      </span>
      <div className="change-banner-actions">
        <button type="button" className="banner-btn" onClick={() => void save()}>
          Recreate…
        </button>
        <button
          type="button"
          className="banner-btn banner-btn-primary"
          onClick={() => void saveAs()}
        >
          Save As…
        </button>
      </div>
    </div>
  );
}
