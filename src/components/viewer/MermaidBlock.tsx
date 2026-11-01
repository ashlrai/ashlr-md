import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../store/settingsStore";

let idCounter = 0;

interface MermaidBlockProps {
  code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const theme = useSettingsStore((s) => s.theme);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${idCounter++}`);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        // Re-init each render so a theme change is reflected.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "midnight" ? "dark" : "default",
        });
        const { svg } = await mermaid.render(idRef.current, code);
        if (active) {
          // Defense-in-depth: even with mermaid's strict security level, scrub
          // the generated SVG before injecting it as raw HTML.
          setSvg(
            DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
            }),
          );
          setError(null);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [code, theme]);

  if (error) {
    return (
      <div className="mermaid-block">
        <div className="mermaid-error">Diagram error: {error}</div>
      </div>
    );
  }

  // Still rendering (mermaid loads on demand): marked, so an export waits
  // for the diagram, and keeps its source if it never comes. An export
  // taken meanwhile held an empty block.
  if (!svg) {
    return <div className="mermaid-block mermaid-block--loading" data-code={code} />;
  }

  return (
    <div
      className="mermaid-block"
      // SVG is produced by mermaid from local document content.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
