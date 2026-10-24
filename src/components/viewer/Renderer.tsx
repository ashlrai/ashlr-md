import { invoke } from "@tauri-apps/api/core";
import {
  createElement,
  isValidElement,
  type MouseEvent,
  memo,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  useRemoteImagesAllowed,
  useRemoteImagesStore,
} from "../../store/remoteImagesStore";
import { useUiStore } from "../../store/uiStore";
import "katex/dist/katex.min.css";
import { type DocKind, detectDocKind } from "../../lib/agent-detect";
import {
  anchorElement,
  imageSource,
  type LinkTarget,
  linkOpenError,
  linkTarget,
  resolveLinkTarget,
  scrollToFragment,
} from "../../lib/docLinks";
import { smoothScrollBehavior } from "../../lib/motion";
import type { OtOperation } from "../../lib/ot";
import { rehypeSourceLines } from "../../lib/rehype-source-lines";
import { rehypeTaskLines } from "../../lib/rehype-task-lines";
import { remarkBlockIds } from "../../lib/remark-block-ids";
import { type CalloutType, remarkCallouts } from "../../lib/remark-callouts";
import { remarkComments } from "../../lib/remark-comments";
import { remarkHighlights } from "../../lib/remark-highlights";
import { remarkWikilinks } from "../../lib/remark-wikilinks";
import { detectReviewDoc } from "../../lib/reviewDoc";
import { SANITIZE_SCHEMA } from "../../lib/sanitizeSchema";
import { useDocumentStore } from "../../store/documentStore";
import { toast } from "../../store/toastStore";
import "../../styles/callouts.css";
import "../../styles/reading.css";
import "../../styles/review-doc.css";
import "../../styles/wikilinks.css";
import { LinkPreviewPopover } from "../LinkPreviewPopover";
import { Callout } from "./Callout";
import { CodeBlock } from "./CodeBlock";
import { DiffBlock } from "./DiffBlock";
import { DocPathContext, useDocPath } from "./docPath";
import { FootnoteRef } from "./FootnoteRef";
import { HeadingAnchor } from "./HeadingAnchor";
import { MermaidBlock } from "./MermaidBlock";
import { ReviewSummaryCard } from "./ReviewSummaryCard";
import { TaskCheckbox, TaskSourceContext } from "./TaskCheckbox";
import { WikiEmbed } from "./WikiEmbed";
import { Wikilink } from "./Wikilink";

const CALLOUT_TYPES: CalloutType[] = ["note", "tip", "warning", "important", "caution"];

// ---------------------------------------------------------------------------
// LinkPreviewAnchor
// ---------------------------------------------------------------------------

/**
 * A regular `<a>` element wrapped with `LinkPreviewPopover` so that hovering
 * for 500 ms shows an inline content preview:
 *   • .md / vault links  → first heading + paragraph of the target file
 *   • http(s):// links   → "External link — <domain>" stub (no network fetch)
 *   • anchor / mailto    → no popover shown
 */
function LinkPreviewAnchor({
  href,
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
  // The document holding the link (an embedded note's own file in an embed).
  const currentPath = useDocPath();
  return (
    <LinkPreviewPopover href={href ?? ""} currentPath={currentPath}>
      {(handlers) => (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          {...handlers}
          {...rest}
          onClick={(e) => followLink(e, href, currentPath)}
        >
          {children}
        </a>
      )}
    </LinkPreviewPopover>
  );
}

/**
 * Follow a read-view link ({@link linkTarget}): a web or mail link is left
 * to the opener plugin, a `#heading` scrolls this document, and a link to a
 * Markdown document, or a bare note name found as a wikilink is
 * ({@link resolveLinkTarget}), opens it in a tab (scrolling to its
 * `#heading`). Any
 * other link is not followed, with a toast saying why. They used to do
 * nothing, or open the app's own origin in the browser. A relative link
 * resolves from `docPath`, the document holding it (the open document, or
 * an embedded note's own file).
 */
export function followLink(
  e: MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
  docPath: string | null = useDocumentStore.getState().path,
) {
  const target = linkTarget(href, docPath);
  if (target.kind === "external") return;
  e.preventDefault();
  if (target.kind === "blocked") {
    toast.info(target.reason);
    return;
  }
  if (target.kind === "anchor") {
    const root = e.currentTarget.closest(".markdown-body") ?? document;
    // As the system's reduced-motion setting asks (a `"smooth"` here
    // animated the jump anyway).
    anchorElement(target.id, root)?.scrollIntoView({
      behavior: smoothScrollBehavior(),
      block: "start",
    });
    return;
  }
  if (target.kind === "note") {
    // A bare note name, looked up as a wikilink is: the rule the hover
    // preview resolves by, so the click opens what it showed.
    void resolveLinkTarget(href, docPath).then(openLinkTarget);
    return;
  }
  openLinkTarget(target);
}

/** Open the document a resolved link names, or say why it is not followed. */
function openLinkTarget(target: LinkTarget) {
  if (target.kind === "blocked") {
    toast.info(target.reason);
    return;
  }
  if (target.kind !== "document") return;
  const { path, fragment } = target;
  void useDocumentStore
    .getState()
    .openPath(path, { keepViewOnError: true })
    .then((error) => {
      if (error !== null) toast.error(linkOpenError(path, error));
      else if (fragment) scrollToFragment(fragment);
    });
}

/**
 * A Markdown image: a web image as written, a local one (relative to the
 * document, or absolute) read through Rust as a `data:` URL, as `![[x.png]]`
 * embeds are. A relative path used to load from the app's own origin, so a
 * pasted image (`![](assets/x.png)`) never showed. A missing or refused image
 * shows its alt text and why.
 */
function MarkdownImage({
  src,
  alt,
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  const docPath = useDocPath();
  const source = useMemo(() => imageSource(src, docPath), [src, docPath]);
  const [local, setLocal] = useState<{ path: string; url: string | null } | null>(null);
  useEffect(() => {
    if (source.kind !== "local") return;
    let cancelled = false;
    invoke<string>("read_image_data_url", { path: source.path })
      .then((url) => {
        if (!cancelled) setLocal({ path: source.path, url });
      })
      .catch(() => {
        if (!cancelled) setLocal({ path: source.path, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [source]);
  if (source.kind === "remote") {
    return <RemoteImage src={source.src} alt={alt} title={title} />;
  }
  const name = alt || src || "image";
  if (source.kind === "blocked") {
    return (
      <span className="wikiembed wikiembed--broken" title={source.reason}>
        ⚠ {name}
      </span>
    );
  }
  if (local?.path !== source.path) {
    return (
      <span className="wikiembed wikiembed--loading" data-name={name}>
        Loading {name}…
      </span>
    );
  }
  if (local.url === null) {
    return (
      <span className="wikiembed wikiembed--broken" title={source.path}>
        ⚠ Missing image “{name}”
      </span>
    );
  }
  return <img src={local.url} alt={alt} title={title} loading="lazy" />;
}

/**
 * A web image, loaded only when remote images load for the open document
 * (Settings, or the document's "Load remote images"; remoteImagesStore.ts).
 * Otherwise a placeholder names it and offers to load the document's remote
 * images: the CSP allows `https:` images and cannot change at run time, so
 * the renderer does not render the `<img>`.
 */
function RemoteImage({
  src,
  alt,
  title,
}: {
  src: string;
  alt?: string;
  title?: string;
}) {
  const openPath = useDocumentStore((s) => s.path);
  const allowed = useRemoteImagesAllowed(openPath);
  if (allowed) return <img src={src} alt={alt} title={title} />;
  return (
    <span className="remote-image-blocked" title={src}>
      <span aria-hidden="true">🖼 </span>
      {alt || "Remote image"}
      <button
        type="button"
        className="remote-image-load"
        onClick={() => useRemoteImagesStore.getState().allow(openPath)}
      >
        Load remote images
      </button>
    </span>
  );
}

/**
 * A `<source srcset>` in raw HTML (`<picture>`), whose web image loads like
 * an `<img>`'s: dropped while remote images are blocked.
 */
function MarkdownSource(props: Record<string, unknown>) {
  const openPath = useDocumentStore((s) => s.path);
  const allowed = useRemoteImagesAllowed(openPath);
  const { node: _node, srcSet, ...rest } = props;
  const remote = typeof srcSet === "string" && /(^|,)\s*https?:/i.test(srcSet);
  if (remote && !allowed) return null;
  return <source srcSet={typeof srcSet === "string" ? srcSet : undefined} {...rest} />;
}

/**
 * The bar over a document with blocked web images: "Load remote images"
 * loads them for this document (and its embeds) for the session. It is
 * found from the rendered page (embeds render their images later), and is
 * left out of exports and copies (export.ts).
 */
function RemoteImagesBanner({
  rootRef,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const openPath = useDocumentStore((s) => s.path);
  const allowed = useRemoteImagesAllowed(openPath);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (allowed || !root) {
      setBlocked(false);
      return;
    }
    const check = () =>
      setBlocked(root.querySelector(".remote-image-blocked") !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [allowed, rootRef]);
  if (allowed || !blocked) return null;
  return (
    <div className="remote-images-banner" role="status">
      Remote images in this document are not loaded.
      <button
        type="button"
        className="remote-image-load"
        onClick={() => useRemoteImagesStore.getState().allow(openPath)}
      >
        Load remote images
      </button>
    </div>
  );
}

/** Recursively collect plain text from React children (for fenced code). */
function textOf(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Detect a `callout-<type>` class (className may be a string or an array). */
function calloutTypeOf(className: unknown): CalloutType | null {
  const classes = Array.isArray(className)
    ? (className as string[])
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];
  const hit = classes.find((c) => c.startsWith("callout-"));
  const type = hit?.slice("callout-".length) as CalloutType | undefined;
  return type && CALLOUT_TYPES.includes(type) ? type : null;
}

interface HeadingProps {
  node?: { properties?: { id?: string } };
  children?: ReactNode;
  id?: string;
  /** The line the heading is on (rehype-source-lines), for a search hit. */
  "data-source-line"?: number;
}

/** Render h1–h6 with a hover-revealed copy-anchor button keyed off the slug id. */
function heading(level: number, props: HeadingProps) {
  const id = props.id ?? props.node?.properties?.id;
  return createElement(
    `h${level}`,
    { id, "data-source-line": props["data-source-line"] },
    props.children,
    id ? <HeadingAnchor key="anchor" slug={id} /> : null,
  );
}

const components: Components = {
  // Replace the default <pre> with our themed code block / mermaid renderer.
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement(child)) {
      const props = child.props as { className?: string; children?: ReactNode };
      const match = /language-([\w+#-]+)/.exec(props.className ?? "");
      const lang = match?.[1]?.toLowerCase() ?? "text";
      const code = textOf(props.children).replace(/\n$/, "");
      if (lang === "mermaid") return <MermaidBlock code={code} />;
      if (lang === "diff") return <DiffBlock code={code} />;
      return <CodeBlock code={code} lang={lang} />;
    }
    return <pre>{children}</pre>;
  },
  // Open links in a new context; strip the react-markdown `node` prop.
  // All non-wikilink, non-footnote anchors are wrapped in LinkPreviewPopover
  // so hovering them shows an inline content preview (Obsidian-style).
  a({ href, children, node, ...rest }) {
    const classes = node?.properties?.className;
    // Obsidian-style [[internal link]] (tagged by remark-wikilinks).
    if (Array.isArray(classes) && classes.includes("wikilink")) {
      const target = String(node?.properties?.dataWikitarget ?? "");
      const aliasProp = node?.properties?.dataWikialias;
      return (
        <Wikilink
          target={target}
          alias={aliasProp != null ? String(aliasProp) : undefined}
        />
      );
    }
    // GFM footnote references get a hover preview of their definition.
    if (href?.startsWith("#user-content-fn-")) {
      return (
        <FootnoteRef href={href} {...rest}>
          {children}
        </FootnoteRef>
      );
    }
    // All other links (regular markdown links + external URLs) get the
    // inline link preview popover on hover.
    return (
      <LinkPreviewAnchor href={href} {...rest}>
        {children}
      </LinkPreviewAnchor>
    );
  },
  source(props) {
    return <MarkdownSource {...(props as Record<string, unknown>)} />;
  },
  img({ src, alt, title }) {
    return (
      <MarkdownImage
        src={typeof src === "string" ? src : undefined}
        alt={alt}
        title={title}
      />
    );
  },
  h1: (p) => heading(1, p),
  h2: (p) => heading(2, p),
  h3: (p) => heading(3, p),
  h4: (p) => heading(4, p),
  h5: (p) => heading(5, p),
  h6: (p) => heading(6, p),
  // Interactive GFM task-list checkboxes (write back to the source file).
  input(props) {
    if (props.type === "checkbox") {
      return <TaskCheckbox node={props.node} checked={props.checked} />;
    }
    const { node: _node, ...rest } = props;
    return <input {...rest} />;
  },
  // Callout cards: remark-callouts marks blockquotes as <div class="callout callout-*">.
  div(props) {
    const { node, className, children, ...rest } = props;
    // ![[embed]] transclusion (tagged by remark-wikilinks).
    const classList = Array.isArray(className)
      ? (className as string[])
      : typeof className === "string"
        ? className.split(/\s+/)
        : [];
    if (classList.includes("wikiembed")) {
      const sizeProp = node?.properties?.dataEmbedSize;
      return (
        <WikiEmbed
          target={String(node?.properties?.dataEmbedTarget ?? "")}
          size={sizeProp != null ? String(sizeProp) : undefined}
        />
      );
    }
    const calloutType = calloutTypeOf(className);
    if (calloutType) {
      return (
        <Callout calloutType={calloutType} node={node}>
          {children}
        </Callout>
      );
    }
    const cls = Array.isArray(className)
      ? (className as string[]).join(" ")
      : className;
    return (
      <div className={cls} {...rest}>
        {children}
      </div>
    );
  },
};

const KIND_LABEL: Record<NonNullable<DocKind>, string> = {
  plan: "Plan",
  diff: "Diff",
  "multi-file": "Multi-file",
  spec: "Spec",
  review: "Review",
  runbook: "Runbook",
  generic: "Agent output",
};

function DocKindBadge({
  kind,
  total,
  done,
}: {
  kind: NonNullable<DocKind>;
  total: number;
  done: number;
}) {
  const icon =
    kind === "plan"
      ? "✓"
      : kind === "diff"
        ? "±"
        : kind === "multi-file"
          ? "⊞"
          : kind === "spec"
            ? "◎"
            : kind === "review"
              ? "⬡"
              : kind === "runbook"
                ? "▶"
                : "◈";
  return (
    <div className="doc-kind-badge" data-kind={kind}>
      <span className="doc-kind-badge-icon" aria-hidden="true">
        {icon}
      </span>
      {KIND_LABEL[kind]}
      {total > 0 && (
        <span className="doc-kind-badge-progress">
          {done}/{total}
        </span>
      )}
    </div>
  );
}

// ── OT margin badges ──────────────────────────────────────────────────────────

/**
 * A single diff-style margin badge summarising one remote OT operation.
 *
 * Rendered as an absolutely-positioned overlay anchored to the first affected
 * line.  The badge shows the agent id and a +N / -N character-count summary.
 * CSS classes follow the existing `.doc-kind-badge` naming convention so they
 * pick up the design-system colour tokens automatically.
 */
function OtChangeBadge({ op }: { op: OtOperation }) {
  const s = op.summary;
  if (!s) return null;

  const label = op.agentId.length > 12 ? `${op.agentId.slice(0, 10)}…` : op.agentId;

  return (
    <div
      className="ot-change-badge"
      data-agent={op.agentId}
      data-first-line={s.firstLine}
      data-last-line={s.lastLine}
      title={`${op.agentId}: +${s.insertedChars} / -${s.deletedChars} chars (lines ${s.firstLine + 1} to ${s.lastLine + 1})`}
    >
      <span className="ot-change-badge-agent">{label}</span>
      {s.insertedChars > 0 && (
        <span className="ot-change-badge-ins">+{s.insertedChars}</span>
      )}
      {s.deletedChars > 0 && (
        <span className="ot-change-badge-del">-{s.deletedChars}</span>
      )}
    </div>
  );
}

/**
 * Overlay container that renders all pending remote OT badges.
 * Positioned relative to `.markdown-body`; each badge is absolutely placed
 * using a CSS custom property `--ot-line` that CSS rules can map to a top
 * offset via `calc(var(--ot-line) * <line-height>)`.
 */
function OtChangeBadgeLayer({ ops }: { ops: OtOperation[] }) {
  if (ops.length === 0) return null;
  return (
    <div className="ot-change-badge-layer" aria-live="polite">
      {ops.map((op) => (
        <OtChangeBadge key={op.id} op={op} />
      ))}
    </div>
  );
}

// ── Renderer ──────────────────────────────────────────────────────────────────

interface RendererProps {
  content: string;
}

export const Renderer = memo(function Renderer({ content }: RendererProps) {
  const info = useMemo(() => detectDocKind(content), [content]);
  // Bespoke summary for agent review / findings docs. null for ordinary docs,
  // so this is entirely non-invasive — nothing below changes when it's null.
  const review = useMemo(() => detectReviewDoc(content), [content]);

  // Subscribe to pending remote OT ops for the margin badge layer.
  const pendingOps = useDocumentStore((s) => s.pendingOps);

  // Classified semantic doc type (PLAN/REVIEW/SPEC/RUNBOOK/GENERIC).
  // Used to auto-select the best renderer and apply CSS hints.
  const currentDocType = useUiStore((s) => s.currentDocType);

  // Stable selector avoids unnecessary re-renders when the array reference
  // changes but the ops themselves haven't.
  const hasBadges = pendingOps.length > 0;

  // The open document's renderer (not an embed's) shows the remote images bar.
  const embedded = useContext(DocPathContext) !== undefined;
  const rootRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={rootRef}
      className="markdown-body"
      data-doc-kind={info.kind ?? undefined}
      data-doc-type-classified={currentDocType}
      data-review={review ? "" : undefined}
      style={{ position: "relative" }}
    >
      {review ? (
        <ReviewSummaryCard summary={review} />
      ) : (
        info.kind && (
          <DocKindBadge
            kind={info.kind}
            total={info.kind === "diff" ? info.hunkTotal : info.taskTotal}
            done={info.kind === "diff" ? 0 : info.taskDone}
          />
        )
      )}
      {hasBadges && <OtChangeBadgeLayer ops={pendingOps} />}
      {!embedded && <RemoteImagesBanner rootRef={rootRef} />}
      <TaskSourceContext.Provider value={content}>
        <ReactMarkdown
          remarkPlugins={[
            remarkFrontmatter,
            remarkGfm,
            // Obsidian text syntax: strip %%comments%% first, then ==highlights==,
            // before wikilinks/math claim their delimiters.
            remarkComments,
            remarkHighlights,
            remarkWikilinks,
            remarkMath,
            remarkCallouts,
            // Obsidian `^block` ids anchor their block (not shown as text).
            remarkBlockIds,
          ]}
          // Order matters: raw HTML is parsed, then sanitized, THEN KaTeX renders
          // (its trusted styled output bypasses the sanitizer), then headings get
          // slug ids. See SANITIZE_SCHEMA for the rationale. Task checkboxes
          // get their source line after the sanitizer, so raw HTML cannot set it,
          // and so do the top-level blocks (a search hit scrolls to its line).
          rehypePlugins={[
            rehypeRaw,
            [rehypeSanitize, SANITIZE_SCHEMA],
            rehypeTaskLines,
            rehypeSourceLines,
            rehypeKatex,
            rehypeSlug,
          ]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </TaskSourceContext.Provider>
    </div>
  );
});
