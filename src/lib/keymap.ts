/**
 * keymap.ts — tiny keyboard-shortcut engine.
 *
 * Shortcuts are written as lowercase, plus-delimited strings, e.g.
 *   "mod+k"        → ⌘K (mac) / Ctrl+K (other)
 *   "mod+shift+l"  → ⌘⇧L
 *   "mod+1"        → ⌘1
 *
 * `mod` resolves to the platform-conventional command modifier: ⌘ (metaKey)
 * on macOS, Ctrl elsewhere. This is the single place that knows how a
 * shortcut string maps to a real KeyboardEvent, so the command registry and
 * the global key handler stay in sync.
 */

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

interface ParsedShortcut {
  /** Requires the platform command modifier (⌘ on mac, Ctrl elsewhere). */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** The bare (lowercased) key, e.g. "k", "1", ",". */
  key: string;
}

const parseCache = new Map<string, ParsedShortcut>();

/** Parse a shortcut string like "mod+shift+l" into its component flags. */
function parse(shortcut: string): ParsedShortcut {
  const cached = parseCache.get(shortcut);
  if (cached) return cached;

  const parsed: ParsedShortcut = {
    mod: false,
    shift: false,
    alt: false,
    key: "",
  };
  for (const raw of shortcut.toLowerCase().split("+")) {
    const part = raw.trim();
    if (part === "mod") parsed.mod = true;
    else if (part === "shift") parsed.shift = true;
    else if (part === "alt" || part === "option" || part === "opt") parsed.alt = true;
    else if (part) parsed.key = part;
  }
  parseCache.set(shortcut, parsed);
  return parsed;
}

/**
 * Map a shifted punctuation character back to the unshifted key it lives on,
 * so a shortcut written with the base key (e.g. "mod+shift+]") still matches
 * even though the browser reports the shifted glyph in `KeyboardEvent.key`
 * (e.g. "}" for Shift+]). Only the keys we actually bind need entries.
 */
const SHIFTED_TO_BASE: Record<string, string> = {
  "}": "]",
  "{": "[",
};

/** Normalize an event's key to the bare, lowercased token used in shortcuts. */
function eventKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  return SHIFTED_TO_BASE[k] ?? k;
}

/**
 * True when `e` matches `shortcut`. Modifier matching is exact for mod / shift
 * / alt so that e.g. "mod+l" does not also fire on "mod+shift+l".
 */
export function matchShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const s = parse(shortcut);
  const modActive = IS_MAC ? e.metaKey : e.ctrlKey;
  // The non-command modifier must NOT be held, otherwise "mod+k" would also
  // match Ctrl+K on a mac (where Ctrl is a distinct, meaningful modifier).
  const otherMod = IS_MAC ? e.ctrlKey : e.metaKey;

  if (s.mod !== modActive) return false;
  if (s.mod && otherMod) return false;
  if (s.shift !== e.shiftKey) return false;
  if (s.alt !== e.altKey) return false;

  return eventKey(e) === s.key;
}

/**
 * Format a shortcut for display, e.g.:
 *   mac:   "mod+shift+l" → "⌘⇧L"
 *   other: "mod+shift+l" → "Ctrl+Shift+L"
 */
export function formatShortcut(shortcut: string): string {
  const s = parse(shortcut);
  const keyLabel = formatKey(s.key);

  if (IS_MAC) {
    let out = "";
    if (s.alt) out += "⌥";
    if (s.shift) out += "⇧";
    if (s.mod) out += "⌘";
    return out + keyLabel;
  }

  const parts: string[] = [];
  if (s.mod) parts.push("Ctrl");
  if (s.alt) parts.push("Alt");
  if (s.shift) parts.push("Shift");
  parts.push(keyLabel);
  return parts.join("+");
}

/** Human-readable label for a single key token. */
function formatKey(key: string): string {
  switch (key) {
    case ",":
      return ",";
    case "arrowup":
      return "↑";
    case "arrowdown":
      return "↓";
    case "enter":
      return "↵";
    case "escape":
      return "Esc";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * Whether `e` is an Escape that should close or dismiss something: Escape,
 * and not one that belongs to an input-method composition. Pressing Escape
 * to end a composition (or close its candidate list) while typing in a
 * dialog's field used to close the dialog and drop what was being typed.
 * `isComposing` covers most engines; WebKit reports the Escape that ends a
 * composition with `isComposing` false but `keyCode` 229.
 *
 * Takes a DOM `KeyboardEvent` or a React keyboard event.
 */
export function isDismissEscape(e: KeyEventLike): boolean {
  return e.key === "Escape" && !isImeKey(e);
}

/**
 * Whether `e` is an Enter that should run or submit something: Enter, and
 * not one that commits an input-method composition. Pressing Enter to
 * accept a composition's text in the command palette or find bar used to
 * run the selected command or jump to the next match as well. Same
 * composition check as `isDismissEscape`.
 *
 * Takes a DOM `KeyboardEvent` or a React keyboard event.
 */
export function isActionEnter(e: KeyEventLike): boolean {
  return e.key === "Enter" && !isImeKey(e);
}

/** A DOM `KeyboardEvent` or a React keyboard event. */
type KeyEventLike = KeyboardEvent | { key: string; nativeEvent: KeyboardEvent };

/**
 * True when the key belongs to an input-method composition. `isComposing`
 * covers most engines; WebKit reports the key that ends a composition with
 * `isComposing` false but `keyCode` 229.
 */
function isImeKey(e: KeyEventLike): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  return native.isComposing || native.keyCode === 229;
}
