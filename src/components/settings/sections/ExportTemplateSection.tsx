/**
 * ExportTemplateSection.tsx — settings panel section for managing export templates.
 *
 * Features:
 *  - Select active template from built-ins + user templates
 *  - Live CSS preview (updates the preview iframe on change)
 *  - Add / duplicate / edit / delete user templates
 *  - Validation of user CSS before save
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BUILTIN_TEMPLATES,
  NO_TEMPLATE_ID,
  validateTemplateCss,
  type ExportTemplate,
} from "../../../lib/exportTemplates";
import { useSettingsStore } from "../../../store/settingsStore";
import { CheckIcon, CopyIcon, MinusIcon, PlusIcon } from "../icons";

// ─── Preview HTML skeleton ─────────────────────────────────────────────────────

function buildPreviewHtml(css: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:#222}
${css}
</style>
</head>
<body>
<article class="reading-surface" style="padding:16px 20px">
  <h1>Document Title</h1>
  <p>This is a paragraph with <strong>bold text</strong>, <em>italics</em>, and <code>inline code</code>.</p>
  <h2>Section Heading</h2>
  <p>A second paragraph. <a href="#">A hyperlink</a> and more content follows here.</p>
  <pre><code>const answer = 42;
// syntax-highlighted code block</code></pre>
  <blockquote><p>A blockquote with important context.</p></blockquote>
  <table>
    <thead><tr><th>Column A</th><th>Column B</th></tr></thead>
    <tbody>
      <tr><td>Alpha</td><td>1</td></tr>
      <tr><td>Beta</td><td>2</td></tr>
    </tbody>
  </table>
</article>
</body>
</html>`;
}

// ─── Template list item ────────────────────────────────────────────────────────

interface TemplateItemProps {
  template: ExportTemplate;
  isActive: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
}

function TemplateItem({
  template,
  isActive,
  onSelect,
  onDuplicate,
  onDelete,
  onEdit,
}: TemplateItemProps) {
  return (
    <div
      className={`export-tpl-item${isActive ? " active" : ""}`}
      role="option"
      aria-selected={isActive}
    >
      <button
        type="button"
        className="export-tpl-item-name"
        onClick={onSelect}
        title={`Use "${template.name}" template`}
      >
        {isActive && (
          <span className="export-tpl-check" aria-hidden="true">
            <CheckIcon />
          </span>
        )}
        <span>{template.name}</span>
        {template.builtin && (
          <span className="export-tpl-badge">built-in</span>
        )}
      </button>

      <div className="export-tpl-actions">
        <button
          type="button"
          className="export-tpl-action-btn"
          onClick={onDuplicate}
          title="Duplicate template"
          aria-label={`Duplicate ${template.name}`}
        >
          <CopyIcon />
        </button>
        {!template.builtin && onEdit && (
          <button
            type="button"
            className="export-tpl-action-btn"
            onClick={onEdit}
            title="Edit template CSS"
            aria-label={`Edit ${template.name}`}
          >
            {/* Pencil icon */}
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
              <path
                d="M11.5 2.5a1.5 1.5 0 0 1 2 2L5 13l-3 1 1-3L11.5 2.5Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        {!template.builtin && onDelete && (
          <button
            type="button"
            className="export-tpl-action-btn export-tpl-action-del"
            onClick={onDelete}
            title="Delete template"
            aria-label={`Delete ${template.name}`}
          >
            <MinusIcon />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── CSS editor sub-panel ──────────────────────────────────────────────────────

interface CssEditorProps {
  template: ExportTemplate;
  onSave: (name: string, css: string) => void;
  onCancel: () => void;
}

function CssEditor({ template, onSave, onCancel }: CssEditorProps) {
  const [name, setName] = useState(template.name);
  const [css, setCss] = useState(template.css);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLIFrameElement>(null);

  // Debounced preview update
  useEffect(() => {
    const id = setTimeout(() => {
      const iframe = previewRef.current;
      if (!iframe) return;
      const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
      if (!doc) return;
      doc.open();
      doc.write(buildPreviewHtml(css));
      doc.close();
    }, 200);
    return () => clearTimeout(id);
  }, [css]);

  const handleSave = useCallback(() => {
    const validationError = validateTemplateCss(css);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!name.trim()) {
      setError("Template name cannot be empty.");
      return;
    }
    setError(null);
    onSave(name.trim(), css);
  }, [css, name, onSave]);

  return (
    <div className="export-tpl-editor">
      <div className="export-tpl-editor-header">
        <input
          type="text"
          className="export-tpl-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Template name…"
          aria-label="Template name"
          maxLength={64}
        />
        <div className="export-tpl-editor-actions">
          <button
            type="button"
            className="export-tpl-btn export-tpl-btn-ghost"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="export-tpl-btn export-tpl-btn-primary"
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>

      <div className="export-tpl-editor-body">
        {/* CSS textarea */}
        <div className="export-tpl-css-pane">
          <p className="export-tpl-css-hint">
            CSS is injected after theme tokens, markdown typography, and KaTeX —
            so your rules cascade on top of all base styles.
          </p>
          <textarea
            className="export-tpl-css-textarea"
            value={css}
            onChange={(e) => { setCss(e.target.value); setError(null); }}
            spellCheck={false}
            aria-label="Template CSS"
            rows={16}
          />
          {error && (
            <p className="export-tpl-error" role="alert">{error}</p>
          )}
        </div>

        {/* Live preview */}
        <div className="export-tpl-preview-pane">
          <p className="export-tpl-preview-label">Live preview</p>
          <iframe
            ref={previewRef}
            className="export-tpl-preview-frame"
            title="Template preview"
            sandbox="allow-same-origin"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Main section component ────────────────────────────────────────────────────

export function ExportTemplateSection() {
  const activeTemplateId = useSettingsStore((s) => s.activeTemplateId);
  const userTemplates = useSettingsStore((s) => s.userTemplates);
  const setActiveTemplateId = useSettingsStore((s) => s.setActiveTemplateId);
  const addUserTemplate = useSettingsStore((s) => s.addUserTemplate);
  const updateUserTemplate = useSettingsStore((s) => s.updateUserTemplate);
  const removeUserTemplate = useSettingsStore((s) => s.removeUserTemplate);

  const [editingId, setEditingId] = useState<string | null>(null);

  const allTemplates: ExportTemplate[] = [
    ...BUILTIN_TEMPLATES,
    ...userTemplates,
  ];

  const editingTemplate =
    editingId !== null
      ? userTemplates.find((t) => t.id === editingId) ?? null
      : null;

  function handleDuplicate(tpl: ExportTemplate) {
    const newId = addUserTemplate({
      name: `${tpl.name} (copy)`,
      css: tpl.css,
    });
    setEditingId(newId);
  }

  function handleSaveEdit(id: string, name: string, css: string) {
    updateUserTemplate(id, { name, css });
    setEditingId(null);
  }

  function handleDelete(id: string) {
    removeUserTemplate(id);
    if (editingId === id) setEditingId(null);
  }

  function handleNewTemplate() {
    const newId = addUserTemplate({
      name: "My Template",
      css: "/* Add your custom CSS here */\n.reading-surface {\n  /* e.g. max-width: 800px; */\n}\n",
    });
    setEditingId(newId);
  }

  // If currently editing, show the CSS editor in-panel.
  if (editingTemplate) {
    return (
      <CssEditor
        template={editingTemplate}
        onSave={(name, css) => handleSaveEdit(editingTemplate.id, name, css)}
        onCancel={() => setEditingId(null)}
      />
    );
  }

  return (
    <div className="export-tpl-section">
      <p className="settings-description">
        Choose a named template for HTML and DOCX exports. Template CSS layers
        on top of theme tokens and markdown styles, letting you ship
        professional documents without editing HTML.
      </p>

      {/* "None" option */}
      <div
        className={`export-tpl-item${activeTemplateId === NO_TEMPLATE_ID ? " active" : ""}`}
        role="option"
        aria-selected={activeTemplateId === NO_TEMPLATE_ID}
      >
        <button
          type="button"
          className="export-tpl-item-name"
          onClick={() => setActiveTemplateId(NO_TEMPLATE_ID)}
          title="No template — use base styles"
        >
          {activeTemplateId === NO_TEMPLATE_ID && (
            <span className="export-tpl-check" aria-hidden="true">
              <CheckIcon />
            </span>
          )}
          <span>Default (no template)</span>
        </button>
      </div>

      {/* Template list */}
      <div
        className="export-tpl-list"
        role="listbox"
        aria-label="Export templates"
      >
        {allTemplates.map((tpl) => (
          <TemplateItem
            key={tpl.id}
            template={tpl}
            isActive={activeTemplateId === tpl.id}
            onSelect={() => setActiveTemplateId(tpl.id)}
            onDuplicate={() => handleDuplicate(tpl)}
            onDelete={tpl.builtin ? undefined : () => handleDelete(tpl.id)}
            onEdit={tpl.builtin ? undefined : () => setEditingId(tpl.id)}
          />
        ))}
      </div>

      {/* Add new template */}
      <button
        type="button"
        className="export-tpl-add-btn"
        onClick={handleNewTemplate}
        aria-label="Create new export template"
      >
        <PlusIcon />
        <span>New template</span>
      </button>
    </div>
  );
}
