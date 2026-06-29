import { useEffect, useRef, useState } from "react";
import { exportDocx, exportHtml, exportPdf, exportWithProfile } from "../../lib/export";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useDocumentStore } from "../../store/documentStore";
import { useUiStore } from "../../store/uiStore";
import "../../styles/export.css";

// ─── Icon components ─────────────────────────────────────────────────────────

function PdfIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x="3"
        y="2"
        width="14"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M7 8h3.5a1.5 1.5 0 0 1 0 3H7V8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M7 11v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M13 11v3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M13 11c0 1.657-.672 3-1.5 3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DocxIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x="3"
        y="2"
        width="14"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M6.5 7h7M6.5 10h7M6.5 13h4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HtmlIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M7 7 4 10l3 3M13 7l3 3-3 3M11 6l-2 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2 2l10 10M12 2 2 12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NotionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3" y="2" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 6h8M6 10h8M6 14h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function SlackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="13" cy="7" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="13" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="13" cy="13" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 7l8 5 8-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ExportStatus =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "ok"; label: string }
  | { kind: "error"; message: string };

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Modal dialog for exporting the current document as PDF, DOCX, or HTML.
 *
 * Rendered at the Shell level so it sits above all app chrome.
 * Visibility is controlled by `useUiStore.exportOpen`.
 */
export function ExportDialog() {
  const close = useUiStore((s) => s.closeExport);
  const fileName = useDocumentStore((s) => s.fileName);
  // Strip extension for use as the export title.
  const title = fileName.replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "") || "export";

  const [status, setStatus] = useState<ExportStatus>({ kind: "idle" });
  const busy = status.kind === "busy";

  // Reset status when dialog is opened.
  useEffect(() => {
    setStatus({ kind: "idle" });
  }, []);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  // Trap focus inside the dialog (Tab cycling) and restore focus to the trigger
  // on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  // ── Generic runner ────────────────────────────────────────────────────────

  // Toasts (success / failure) are emitted by the export functions themselves
  // (src/lib/export.ts) so the command-palette export paths get them too; the
  // dialog just drives its own inline status + auto-close.
  async function run(label: string, fn: () => Promise<void>): Promise<void> {
    setStatus({ kind: "busy", label: `Exporting ${label}…` });
    try {
      await fn();
      setStatus({ kind: "ok", label: `${label} exported.` });
      // Auto-close after a short success pause.
      setTimeout(close, 1200);
    } catch (e) {
      const msg = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
      setStatus({ kind: "error", message: msg });
    }
  }

  // ── Status text ───────────────────────────────────────────────────────────

  const statusClass = `export-status export-status-${status.kind}`;
  const statusText =
    status.kind === "idle"
      ? " " // non-breaking space preserves row height
      : status.kind === "busy"
        ? status.label
        : status.kind === "ok"
          ? `✓ ${status.label}`
          : `⚠ ${status.message}`;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    /* Backdrop — click outside to close */
    <div
      className="export-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        // Only close when clicking the backdrop itself, not the dialog.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        ref={dialogRef}
      >
        {/* Header */}
        <div className="export-header">
          <h2 className="export-title" id="export-dialog-title">
            Export Document
          </h2>
          <button
            type="button"
            className="export-close-btn"
            onClick={close}
            aria-label="Close export dialog"
          >
            <CloseIcon />
          </button>
        </div>
        <p className="export-subtitle">
          Choose a format for&nbsp;
          <strong>{title}</strong>
        </p>

        {/* Format buttons */}
        <div className="export-formats">
          <button
            type="button"
            className="export-format-btn"
            disabled={busy}
            onClick={() => run("PDF", () => exportPdf(title))}
          >
            <span className="export-format-icon">
              <PdfIcon />
            </span>
            <span className="export-format-text">
              <span className="export-format-name">PDF</span>
              <span className="export-format-desc">
                Print to PDF via the system dialog — best for sharing or archiving
              </span>
            </span>
          </button>

          <button
            type="button"
            className="export-format-btn"
            disabled={busy}
            onClick={() => run("Word (.docx)", () => exportDocx(title))}
          >
            <span className="export-format-icon">
              <DocxIcon />
            </span>
            <span className="export-format-text">
              <span className="export-format-name">Word (.docx)</span>
              <span className="export-format-desc">
                Editable document for Microsoft Word or Pages
              </span>
            </span>
          </button>

          <button
            type="button"
            className="export-format-btn"
            disabled={busy}
            onClick={() => run("HTML", () => exportHtml(title))}
          >
            <span className="export-format-icon">
              <HtmlIcon />
            </span>
            <span className="export-format-text">
              <span className="export-format-name">HTML</span>
              <span className="export-format-desc">
                Self-contained offline webpage — themes, diagrams, and math included
              </span>
            </span>
          </button>

          <button
            type="button"
            className="export-format-btn"
            disabled={busy}
            onClick={() => run("Notion HTML", () => exportWithProfile("notion-html", title))}
          >
            <span className="export-format-icon">
              <NotionIcon />
            </span>
            <span className="export-format-text">
              <span className="export-format-name">Notion</span>
              <span className="export-format-desc">
                Optimised HTML for pasting into Notion — clean semantic markup, simplified tables
              </span>
            </span>
          </button>

          <button
            type="button"
            className="export-format-btn"
            disabled={busy}
            onClick={() => run("Slack (.txt)", () => exportWithProfile("slack-html", title))}
          >
            <span className="export-format-icon">
              <SlackIcon />
            </span>
            <span className="export-format-text">
              <span className="export-format-name">Slack</span>
              <span className="export-format-desc">
                Markdown-preserved plaintext constrained to Slack thread width (~520px)
              </span>
            </span>
          </button>

          <button
            type="button"
            className="export-format-btn"
            disabled={busy}
            onClick={() => run("Email HTML", () => exportWithProfile("email-html", title))}
          >
            <span className="export-format-icon">
              <EmailIcon />
            </span>
            <span className="export-format-text">
              <span className="export-format-name">Email HTML</span>
              <span className="export-format-desc">
                Fully inlined HTML for email clients — responsive, dark-mode, embedded images
              </span>
            </span>
          </button>
        </div>

        {/* Status feedback */}
        <p className={statusClass} role="status" aria-live="polite">
          {statusText}
        </p>

        {/* Footer */}
        <div className="export-footer">
          <button type="button" className="export-cancel-btn" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
