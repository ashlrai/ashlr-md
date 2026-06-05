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
import { type CalloutType, remarkCallouts } from "../../lib/remark-callouts";
import { remarkWikilinks } from "../../lib/remark-wikilinks";
import { SANITIZE_SCHEMA } from "../../lib/sanitizeSchema";
import "../../styles/callouts.css";
import "../../styles/reading.css";
import "../../styles/wikilinks.css";
import { Callout } from "./Callout";
import { CodeBlock } from "./CodeBlock";
import { FootnoteRef } from "./FootnoteRef";
import { HeadingAnchor } from "./HeadingAnchor";
import { MermaidBlock } from "./MermaidBlock";
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
      return <WikiEmbed target={String(node?.properties?.dataEmbedTarget ?? "")} />;
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
    kind === "plan" ? "✓" : kind === "diff" ? "±" : kind === "multi-file" ? "⊞" : "◈";
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

interface RendererProps {
  content: string;
}

export const Renderer = memo(function Renderer({ content }: RendererProps) {
  const info = useMemo(() => detectDocKind(content), [content]);

  return (
    <div className="markdown-body" data-doc-kind={info.kind ?? undefined}>
      {info.kind && (
        <DocKindBadge kind={info.kind} total={info.taskTotal} done={info.taskDone} />
      )}
      <ReactMarkdown
        remarkPlugins={[
          remarkFrontmatter,
          remarkGfm,
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
