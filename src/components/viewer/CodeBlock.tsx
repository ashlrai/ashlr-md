import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { highlightCode } from "../../lib/shiki";
import { CodeActions } from "./CodeActions";

interface CodeBlockProps {
  code: string;
  lang: string;
}

interface RunOutput {
  stdout: string;
  stderr: string;
  success: boolean;
}

export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [output, setOutput] = useState<RunOutput | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    if (lang && lang !== "text") {
      highlightCode(code, lang)
        .then((result) => {
          if (isMounted.current) setHtml(result);
        })
        .catch(() => {
          if (isMounted.current) setHtml(null);
        });
    } else {
      setHtml(null);
    }
    return () => {
      isMounted.current = false;
    };
  }, [code, lang]);

  // Runs only after the user confirms in CodeActions ("Run this command?").
  async function handleRun(cmd: string) {
    try {
      const res = await invoke<RunOutput>("run_shell", { cmd });
      setOutput(res);
    } catch (e) {
      setOutput({ stdout: "", stderr: String(e), success: false });
    }
  }

  const outputText =
    output &&
    output.stdout +
      (output.stderr ? `${output.stdout ? "\n" : ""}${output.stderr}` : "");

  return (
    <div className="code-block" data-lang={lang}>
      <div className="code-block-header">
        <span>{lang && lang !== "text" ? lang : "code"}</span>
        <CodeActions code={code} lang={lang} onRun={handleRun} />
      </div>
      {html ? (
        // Shiki output is generated from the local document and is safe to inject.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-plain">
          <code>{code}</code>
        </pre>
      )}
      {output && (
        <div className={`code-output${output.success ? "" : " code-output--error"}`}>
          <div className="code-output-header">
            <span>{output.success ? "Output" : "Failed"}</span>
            <button className="copy-btn" type="button" onClick={() => setOutput(null)}>
              Clear
            </button>
          </div>
          <pre>{outputText || "(no output)"}</pre>
        </div>
      )}
    </div>
  );
}
