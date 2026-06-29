/**
 * LinterToast.tsx — Overlay that surfaces fixable linter violations in the
 * read view with inline Fix buttons.
 *
 * Appears automatically when `lintDocument()` detects violations on the active
 * document. Shows up to 5 summaries; each fixable violation carries a "Fix"
 * button that applies the correction via `documentStore.setContent()`, updates
 * the preview live, and appends the event to the linter's violation history.
 *
 * Rendered at the viewer level (not Shell level) so it stays visually anchored
 * to the reading pane.
 *
 * Usage:
 *   <LinterToast content={doc} onContentChange={(c) => store.setContent(c)} />
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyFix,
  BUILTIN_RULES,
  LINTER_DEFAULT_ENABLED_RULES,
  lintDocument,
  type LintViolation,
} from "../lib/mdlint";
import { useSettingsStore } from "../store/settingsStore";

// ── Violation history (module-level singleton, cleared on document open) ──────

export interface LintHistoryEntry {
  ruleId: string;
  message: string;
  fixedAt: number;
  docSnippet: string;
}

const _violationHistory: LintHistoryEntry[] = [];

/** Read the full violation-fix history (for MCP and tests). */
export function getLintHistory(): readonly LintHistoryEntry[] {
  return _violationHistory;
}

/** Clear the history (called when a new document is opened). */
export function clearLintHistory(): void {
  _violationHistory.length = 0;
}

function appendHistory(v: LintViolation, docSnippet: string): void {
  _violationHistory.push({
    ruleId: v.ruleId,
    message: v.message,
    fixedAt: Date.now(),
    docSnippet,
  });
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function WrenchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
      <path
        d="M10.5 2.5a3.5 3.5 0 0 1 .5 5.5L5 14a1.5 1.5 0 0 1-2-2l6-6.5a3.5 3.5 0 0 1-1.5-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="11" cy="4" r="1" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      width="12"
      height="12"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
    >
      <path
        d="M2.5 4.5l3.5 3 3.5-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseSmallIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" width="12" height="12">
      <path
        d="M3 3l6 6M9 3l-6 6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Severity badge colour ─────────────────────────────────────────────────────

function severityColor(severity: LintViolation["severity"]): string {
  if (severity === "error") return "var(--color-error, #d33)";
  if (severity === "warning") return "var(--color-warning, #c80)";
  return "var(--color-fg-muted, #888)";
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface LinterToastProps {
  /** Current document content to lint. */
  content: string;
  /** Called when a fix is applied — passes the corrected content. */
  onContentChange: (content: string) => void;
  /** Maximum violations to show (default 5). */
  maxVisible?: number;
}

export function LinterToast({
  content,
  onContentChange,
  maxVisible = 5,
}: LinterToastProps) {
  const linterConfig = useSettingsStore((s) => s.linterConfig);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(true);
  // Track the content snapshot at the time we last computed violations so we
  // can re-run the linter only when content actually changes.
  const lastContent = useRef<string | null>(null);
  const [violations, setViolations] = useState<LintViolation[]>([]);

  // Reset dismissed state whenever content changes substantially (new document).
  const prevContent = useRef(content);
  useEffect(() => {
    if (prevContent.current !== content) {
      // Only reset the dismissed flag when the document identity changes
      // (more than minor edits).  We use a simple length threshold here.
      const prevLen = prevContent.current.length;
      const nextLen = content.length;
      if (Math.abs(prevLen - nextLen) > 100) {
        setDismissed(false);
        setExpanded(true);
        clearLintHistory();
      }
      prevContent.current = content;
    }
  }, [content]);

  // Re-run the linter on content + config changes (debounced 300 ms to avoid
  // running on every keystroke in split-view mode).
  useEffect(() => {
    const handle = setTimeout(() => {
      if (lastContent.current === content) return;
      lastContent.current = content;
      const result = lintDocument(content, {
        rules: BUILTIN_RULES,
        disabledRules: linterConfig.disabledRules,
      });
      // Only surface violations from the four default-enabled rules in the toast
      // (the others appear as editor squiggles).
      const toastRules = new Set(
        LINTER_DEFAULT_ENABLED_RULES.filter(
          (id) => !linterConfig.disabledRules.includes(id),
        ),
      );
      setViolations(result.filter((v) => toastRules.has(v.ruleId)));
    }, 300);
    return () => clearTimeout(handle);
  }, [content, linterConfig]);

  // Memoize the slice to avoid re-slicing on every render.
  const visible = useMemo(
    () => violations.slice(0, maxVisible),
    [violations, maxVisible],
  );
  const overflow = violations.length - visible.length;

  if (dismissed || violations.length === 0) return null;

  function handleFix(v: LintViolation) {
    if (!v.fix) return;
    const snippet = content.slice(
      Math.max(0, (v.range?.from.offset ?? 0) - 20),
      Math.min(content.length, (v.range?.to.offset ?? 0) + 20),
    );
    const fixed = applyFix(content, v);
    appendHistory(v, snippet);
    onContentChange(fixed);
  }

  function handleFixAll() {
    let current = content;
    for (const v of violations) {
      if (!v.fix) continue;
      const snippet = current.slice(
        Math.max(0, (v.range?.from.offset ?? 0) - 20),
        Math.min(current.length, (v.range?.to.offset ?? 0) + 20),
      );
      current = applyFix(current, v);
      appendHistory(v, snippet);
    }
    onContentChange(current);
  }

  const fixableCount = violations.filter((v) => v.fix !== null).length;

  return (
    <div
      className="linter-toast"
      role="region"
      aria-label="Linter suggestions"
      aria-live="polite"
    >
      {/* Header row */}
      <div className="linter-toast__header">
        <span className="linter-toast__icon">
          <WrenchIcon />
        </span>
        <span className="linter-toast__title">
          {violations.length} linter {violations.length === 1 ? "suggestion" : "suggestions"}
        </span>
        {fixableCount > 1 && (
          <button
            type="button"
            className="linter-toast__fix-all"
            onClick={handleFixAll}
            title={`Fix all ${fixableCount} auto-fixable violations`}
          >
            Fix all
          </button>
        )}
        <button
          type="button"
          className="linter-toast__toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse linter suggestions" : "Expand linter suggestions"}
          onClick={() => setExpanded((e) => !e)}
        >
          <ChevronIcon open={expanded} />
        </button>
        <button
          type="button"
          className="linter-toast__dismiss"
          aria-label="Dismiss linter suggestions"
          onClick={() => setDismissed(true)}
        >
          <CloseSmallIcon />
        </button>
      </div>

      {/* Violation list */}
      {expanded && (
        <ul className="linter-toast__list" role="list">
          {visible.map((v, i) => (
            <li key={`${v.ruleId}-${i}`} className="linter-toast__item">
              <span
                className="linter-toast__severity"
                style={{ color: severityColor(v.severity) }}
                aria-label={v.severity}
              />
              <span className="linter-toast__message">
                {v.range
                  ? `Line ${v.range.from.line}: ${v.message}`
                  : v.message}
              </span>
              {v.fix && (
                <button
                  type="button"
                  className="linter-toast__fix-btn"
                  onClick={() => handleFix(v)}
                >
                  Fix
                </button>
              )}
            </li>
          ))}
          {overflow > 0 && (
            <li className="linter-toast__overflow">
              +{overflow} more — open Settings → Linter rules to manage
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
