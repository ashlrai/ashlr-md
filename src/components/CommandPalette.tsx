import { useEffect, useMemo, useRef, useState } from "react";
import { COMMAND_GROUPS, type Command, getCommands } from "../lib/commands";
import { formatShortcut, isActionEnter, isDismissEscape } from "../lib/keymap";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useDocumentStore } from "../store/documentStore";
import { useRecentStore } from "../store/recentStore";
import { useUiStore } from "../store/uiStore";

// ───────────────────────────────────────────────────────────────────────────
// Fuzzy matcher
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lightweight subsequence fuzzy match. Returns a score (higher = better) or
 * -1 when `query` is not a subsequence of `text`. Rewards contiguous runs,
 * word-boundary hits, and an early first match — enough to feel "smart"
 * without a dependency.
 */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) {
        found = j;
        break;
      }
    }
    if (found === -1) return -1;

    // Base point per matched char.
    score += 1;
    // Contiguous run bonus.
    if (found === prevMatch + 1) score += 4;
    // Word-boundary bonus (start of string or after a separator).
    if (found === 0 || /[\s\-_/.]/.test(t[found - 1])) score += 3;
    // Earlier matches are slightly better.
    score -= found * 0.01;

    prevMatch = found;
    ti = found + 1;
  }
  return score;
}

/** Best score across the command's title + keywords. */
function scoreCommand(query: string, cmd: Command): number {
  const haystacks = [cmd.title, ...(cmd.keywords ?? [])];
  let best = -1;
  for (const h of haystacks) {
    const s = fuzzyScore(query, h);
    if (s > best) best = s;
  }
  return best;
}

// ───────────────────────────────────────────────────────────────────────────
// Row model
// ───────────────────────────────────────────────────────────────────────────

interface PaletteRow {
  key: string;
  title: string;
  hint?: string;
  shortcut?: string;
  group: string;
  run: () => void | Promise<void>;
}

const RECENTS_GROUP = "Recent";

function commandToRow(cmd: Command): PaletteRow {
  return {
    key: cmd.id,
    title: cmd.title,
    hint: cmd.hint,
    shortcut: cmd.shortcut,
    group: cmd.group,
    run: cmd.run,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const close = useUiStore((s) => s.closeCommandPalette);

  if (!open) return null;
  return <PaletteBody onClose={close} />;
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Subscribe so the list re-derives if recents change while open.
  const recents = useRecentStore((s) => s.recents);
  const openPath = useDocumentStore((s) => s.openPath);

  // Build the available, filtered, grouped rows.
  const rows = useMemo<PaletteRow[]>(() => {
    const available = getCommands().filter((c) => !c.when || c.when());
    const q = query.trim();

    if (!q) {
      // Empty query: surface recent files first, then all commands by group.
      const recentRows: PaletteRow[] = recents.slice(0, 5).map((r) => ({
        key: `recent:${r.path}`,
        title: `Open recent: ${r.fileName}`,
        hint: r.path,
        group: RECENTS_GROUP,
        run: async () => {
          await openPath(r.path);
        },
      }));
      const commandRows = available.map(commandToRow).sort(byGroupOrder);
      return [...recentRows, ...commandRows];
    }

    // Filtered: score commands AND recents, drop non-matches, sort by score.
    const scored: { row: PaletteRow; score: number }[] = [];
    for (const c of available) {
      const score = scoreCommand(q, c);
      if (score >= 0) scored.push({ row: commandToRow(c), score });
    }
    for (const r of recents) {
      const score = fuzzyScore(q, r.fileName);
      if (score >= 0) {
        scored.push({
          row: {
            key: `recent:${r.path}`,
            title: `Open recent: ${r.fileName}`,
            hint: r.path,
            group: RECENTS_GROUP,
            run: async () => {
              await openPath(r.path);
            },
          },
          score: score + 1, // gentle nudge so a matching recent ranks well
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.row);
  }, [query, recents, openPath]);

  // Keep the active index in bounds when the result set changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every query change
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep Tab inside the palette and give focus back to what had it on
  // close. The palette used to remember `document.activeElement` in an
  // effect, after the input's `autoFocus` had already taken focus, so it
  // "restored" focus to its own removed input and focus fell to the page;
  // and Tab left the modal for the app behind it. The trap remembers the
  // trigger before the input is focused below.
  useFocusTrap(panelRef);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll the active row into view as it moves.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function runRow(row: PaletteRow | undefined) {
    if (!row) return;
    onClose();
    // Defer so close-state settles (and focus restore happens) before the
    // action runs — important for actions that open another overlay.
    queueMicrotask(() => row.run());
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // An Escape that ends an IME composition in the query is the input
    // method's; it used to close the palette (see isDismissEscape).
    if (isDismissEscape(e)) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (isActionEnter(e)) {
      // Not an Enter that commits an IME composition (isActionEnter).
      e.preventDefault();
      runRow(rows[active]);
    }
  }

  return (
    <div
      className="cmdk-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={panelRef}
      >
        <div className="cmdk-input-row">
          <SearchIcon />
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            placeholder="Type a command or search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            // A combobox owning the listbox below, so a screen reader
            // announces the row aria-activedescendant names as it moves.
            role="combobox"
            aria-label="Search commands"
            aria-expanded={rows.length > 0}
            aria-controls="cmdk-listbox"
            aria-autocomplete="list"
            aria-activedescendant={rows[active] ? `cmdk-row-${active}` : undefined}
          />
        </div>

        <div
          className="cmdk-list"
          ref={listRef}
          role="listbox"
          id="cmdk-listbox"
          aria-label="Commands"
        >
          {rows.length === 0 ? (
            <div className="cmdk-empty">No matching commands</div>
          ) : (
            // Each run of rows of one group is a role="group" labelled by its
            // header: the headers used to be plain divs among the options,
            // which a listbox may not hold.
            groupRuns(rows).map((run, g) => (
              <div
                key={`g:${run.group}:${run.start}`}
                role="group"
                aria-labelledby={`cmdk-group-${g}`}
              >
                {/* The group's name is read with the group, not as an item. */}
                <div className="cmdk-group" id={`cmdk-group-${g}`} aria-hidden="true">
                  {run.group}
                </div>
                {run.rows.map((row, j) => {
                  const i = run.start + j;
                  const selected = i === active;
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav handled by input
                    // biome-ignore lint/a11y/useFocusableInteractive: ARIA listbox pattern — focus stays on input via aria-activedescendant
                    <div
                      key={row.key}
                      id={`cmdk-row-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={selected}
                      className={`cmdk-row${selected ? " is-active" : ""}`}
                      onMouseMove={() => setActive(i)}
                      onClick={() => runRow(row)}
                    >
                      <div className="cmdk-row-main">
                        <span className="cmdk-row-title">{row.title}</span>
                        {row.hint && <span className="cmdk-row-hint">{row.hint}</span>}
                      </div>
                      {row.shortcut && (
                        <kbd className="cmdk-row-shortcut">
                          {formatShortcut(row.shortcut)}
                        </kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Consecutive rows of one group, with the index of the run's first row. */
export function groupRuns<T extends { group: string }>(
  rows: T[],
): { group: string; start: number; rows: T[] }[] {
  const runs: { group: string; start: number; rows: T[] }[] = [];
  rows.forEach((row, i) => {
    const last = runs[runs.length - 1];
    if (last && last.group === row.group) last.rows.push(row);
    else runs.push({ group: row.group, start: i, rows: [row] });
  });
  return runs;
}

/** Sort commands by the canonical group order, preserving in-group order. */
function byGroupOrder(a: PaletteRow, b: PaletteRow): number {
  const ai = COMMAND_GROUPS.indexOf(a.group as (typeof COMMAND_GROUPS)[number]);
  const bi = COMMAND_GROUPS.indexOf(b.group as (typeof COMMAND_GROUPS)[number]);
  return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
}

function SearchIcon() {
  return (
    <svg
      className="cmdk-search-icon"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M13.5 13.5 17 17"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
