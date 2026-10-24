/**
 * docLinks.ts — what a link or an image in the read view points at, and
 * following it.
 *
 * Every link the read view renders is an `<a target="_blank">`. The opener
 * plugin's click handler takes `http:`, `https:`, `mailto:` and `tel:` ones
 * to the system browser or mail app; anything else did nothing (a `#heading`
 * link, a link to `other.md`) or, on Windows, where the app's origin is
 * `http://tauri.localhost`, opened a relative link in the browser at that
 * origin. A Markdown image with a relative path (`![](assets/x.png)`, what a
 * pasted image inserts) was loaded from the app's origin and never shown.
 *
 * Links to local files open only Markdown documents, through no hidden
 * folder or file the link itself names (`../.ssh/x.md`): a link's text can
 * say anything, and a document opened in a tab is what agents read.
 */

import GithubSlugger from "github-slugger";

/** Extensions of documents a link may open in a tab. */
const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;
/** Extensions `read_image_data_url` reads. */
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
/** Schemes the opener plugin hands to the system (see the module doc). */
const EXTERNAL = /^(https?|mailto|tel):/i;
/** A URL scheme (two characters at least, so `C:\x` is a path). */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

export type LinkTarget =
  /** Left to the opener plugin (the system browser or mail app). */
  | { kind: "external" }
  /** A heading or footnote of this document, by its id. */
  | { kind: "anchor"; id: string }
  /** A Markdown document to open, and the heading to scroll to. */
  | { kind: "document"; path: string; fragment: string | null }
  /** Not followed, and why. */
  | { kind: "blocked"; reason: string };

/** `s` percent-decoded, or as written when it is not valid encoding. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The absolute path `rel` (a link destination, `/`-separated, decoded)
 * names from the document at `docPath`, `.` and `..` resolved; `null` when
 * there is no document to resolve it from. A `..` never climbs past the
 * root.
 */
export function resolveFromDocument(
  docPath: string | null,
  rel: string,
): string | null {
  const windows = docPath != null && /^[a-z]:\\|^\\\\/i.test(docPath);
  const sep = windows ? "\\" : "/";
  const absolute = rel.startsWith("/") || /^[a-z]:[\\/]/i.test(rel);
  if (!absolute && !docPath) return null;
  const parts = absolute ? [] : (docPath ?? "").split(/[\\/]/).slice(0, -1);
  // The root ("" before a leading `/`, or a drive) is never popped.
  const root = absolute
    ? /^[a-z]:/i.test(rel)
      ? rel.slice(0, 2)
      : ""
    : (parts[0] ?? "");
  const out = absolute ? [root] : parts;
  const rest = absolute && root !== "" ? rel.slice(2) : rel;
  for (const seg of rest.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 1) return `${out[0]}${sep}`;
  return out.join(sep);
}

/** Whether a link destination names a hidden folder or file (`.ssh/x`). */
function namesHidden(rel: string): boolean {
  return rel.split(/[\\/]/).some((s) => s.startsWith(".") && s !== "." && s !== "..");
}

/** `href` split at its first `#` (and with any `?query` off the path). */
function splitHref(href: string): { path: string; fragment: string | null } {
  const hash = href.indexOf("#");
  const beforeHash = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? null : decode(href.slice(hash + 1));
  const query = beforeHash.indexOf("?");
  return { path: query < 0 ? beforeHash : beforeHash.slice(0, query), fragment };
}

/** What a click on a read-view link to `href` should do. */
export function linkTarget(
  href: string | undefined,
  docPath: string | null,
): LinkTarget {
  const h = (href ?? "").trim();
  if (h === "") return { kind: "blocked", reason: "The link has no destination." };
  if (h.startsWith("#")) return { kind: "anchor", id: decode(h.slice(1)) };
  if (EXTERNAL.test(h)) return { kind: "external" };
  if (SCHEME.test(h) || h.startsWith("//")) {
    return {
      kind: "blocked",
      reason: `Ashlr MD does not open ${h.split(":")[0] || "this kind of"} links.`,
    };
  }
  const { path, fragment } = splitHref(h);
  const rel = decode(path);
  if (rel === "") return { kind: "anchor", id: fragment ?? "" };
  if (!MARKDOWN_EXT.test(rel)) {
    return { kind: "blocked", reason: "Only Markdown documents open from links." };
  }
  if (namesHidden(rel)) {
    return {
      kind: "blocked",
      reason: "Links into hidden folders or files are not opened.",
    };
  }
  const abs = resolveFromDocument(docPath, rel);
  if (!abs)
    return { kind: "blocked", reason: "Save the document to follow its links." };
  return { kind: "document", path: abs, fragment };
}

export type ImageSource =
  /** Shown as written (a web image). */
  | { kind: "remote"; src: string }
  /** A local image, read through Rust (`read_image_data_url`). */
  | { kind: "local"; path: string }
  /** Not shown, and why. */
  | { kind: "blocked"; reason: string };

/** Where the read view takes an image whose `src` is as written. */
export function imageSource(
  src: string | undefined,
  docPath: string | null,
): ImageSource {
  const s = (src ?? "").trim();
  if (s === "") return { kind: "blocked", reason: "The image has no source." };
  if (/^https?:/i.test(s)) return { kind: "remote", src: s };
  if (SCHEME.test(s) || s.startsWith("//")) {
    return {
      kind: "blocked",
      reason: "The image's address is not a file or a web URL.",
    };
  }
  const rel = decode(splitHref(s).path);
  if (!IMAGE_EXT.test(rel))
    return { kind: "blocked", reason: "Not an image type Ashlr MD shows." };
  if (namesHidden(rel)) {
    return { kind: "blocked", reason: "Images in hidden folders are not shown." };
  }
  const abs = resolveFromDocument(docPath, rel);
  if (!abs) return { kind: "blocked", reason: "Save the document to show its images." };
  return { kind: "local", path: abs };
}

/**
 * The element of the rendered document a `#fragment` names: its id as
 * written, as rehype-sanitize prefixes ids written in raw HTML or footnotes
 * (`user-content-`), or the slug a heading with that text gets
 * (`#My Heading` finds `my-heading`).
 */
export function anchorElement(
  id: string,
  root: ParentNode = document,
): HTMLElement | null {
  if (id === "") return null;
  const byId = (x: string) =>
    root.querySelector<HTMLElement>(`[id="${CSS.escape(x)}"]`);
  return (
    byId(id) ?? byId(`user-content-${id}`) ?? byId(new GithubSlugger().slug(id)) ?? null
  );
}

/**
 * Scroll to the heading `fragment` names once it is rendered (a document
 * opened from a link renders after the open resolves). Returns a function
 * that stops waiting. Block references (`^id`) have no anchor.
 */
export function scrollToFragment(fragment: string): () => void {
  if (fragment === "" || fragment.startsWith("^")) return () => {};
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    const el = anchorElement(fragment);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (tries++ < 12) timer = setTimeout(tick, 60);
  };
  tick();
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}
