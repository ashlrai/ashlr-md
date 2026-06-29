import { createElement, isValidElement, memo, type ReactNode, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { type DocKind, detectDocKind } from "../../lib/agent-detect";
import { type OtOperation } from "../../lib/ot";
import { useDocumentStore } from "../../store/documentStore";
import { type CalloutType, remarkCallouts } from "../../lib/remark-callouts";
import { remarkComments } from "../../lib/remark-comments";
import { remarkHighlights } from "../../lib/remark-highlights";
import { remarkWikilinks } from "../../lib/remark-wikilinks";
import { detectReviewDoc } from "../../lib/reviewDoc";
import { SANITIZE_SCHEMA } from "../../lib/sanitizeSchema";
import "../../styles/callouts.css";
import "../../styles/reading.css";
import "../../styles/review-doc.css";
import "../../styles/wikilinks.css";
import { Callout } from "./Callout";
import { CodeBlock } from "./CodeBlock";
import { DiffBlock } from "./DiffBlock";
import { FootnoteRef } from "./FootnoteRef";
import { HeadingAnchor } from "./HeadingAnchor";
import { MermaidBlock } from "./MermaidBlock";
import { ReviewSummaryCard } from "./ReviewSummaryCard";
import { TaskCheckbox } from "./TaskCheckbox";
import { WikiEmbed } from "./WikiEmbed";
import { Wikilink } from "./Wikilink";

const CALLOUT_TYPES: CalloutType[] = ["note", "tip", "warning", "important", "caution"];

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
}

/** Render h1–h6 with a hover-revealed copy-anchor button keyed off the slug id. */
function heading(level: number, props: HeadingProps) {
  const id = props.id ?? props.node?.properties?.id;
  return createElement(
    `h${level}`,
    { id },
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
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
        {children}
      </a>
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

  const label = op.agentId.length > 12
    ? `${op.agentId.slice(0, 10)}…`
    : op.agentId;

  return (
    <div
      className="ot-change-badge"
      data-agent={op.agentId}
      data-first-line={s.firstLine}
      data-last-line={s.lastLine}
      title={`${op.agentId}: +${s.insertedChars} / -${s.deletedChars} chars (lines ${s.firstLine + 1}–${s.lastLine + 1})`}
      aria-label={`Remote edit by ${op.agentId}`}
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
    <div className="ot-change-badge-layer" aria-live="polite" aria-label="Incoming remote edits">
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

  // Stable selector avoids unnecessary re-renders when the array reference
  // changes but the ops themselves haven't.
  const hasBadges = pendingOps.length > 0;

  return (
    <div
      className="markdown-body"
      data-doc-kind={info.kind ?? undefined}
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
        ]}
        // Order matters: raw HTML is parsed, then sanitized, THEN KaTeX renders
        // (its trusted styled output bypasses the sanitizer), then headings get
        // slug ids. See SANITIZE_SCHEMA for the rationale.
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, SANITIZE_SCHEMA],
          rehypeKatex,
          rehypeSlug,
        ]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
