import { useEffect, useRef } from "react";
import { isDismissEscape } from "../../lib/keymap";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useUiStore } from "../../store/uiStore";
import {
  AgentIcon,
  AppearanceIcon,
  ChartIcon,
  CloseIcon,
  DatabaseIcon,
  ExportIcon,
  LinkIcon,
  LinterIcon,
  MemoryIcon,
  TerminalIcon,
  VaultIcon,
} from "./icons";
import { SectionHeader } from "./SectionHeader";
import { AiMetricsSection } from "./sections/AiMetricsSection";
import { AiProviderSection } from "./sections/AiProviderSection";
import { AnthropicKeySection } from "./sections/AnthropicKeySection";
import {
  ContentWidthStepper,
  FontSizeStepper,
  NotificationToggle,
  RemoteImagesToggle,
  ThemePicker,
} from "./sections/AppearanceControls";
import { CliSection } from "./sections/CliSection";
import { DefaultHandlerSection } from "./sections/DefaultHandlerSection";
import { EmbedSection } from "./sections/EmbedSection";
import { ExportTemplateSection } from "./sections/ExportTemplateSection";
import { LinterRulesSection } from "./sections/LinterRulesSection";
import { McpSection } from "./sections/McpSection";
import { MemorySection } from "./sections/MemorySection";
import { VaultSection } from "./sections/VaultSection";
import "../../styles/settings.css";
import "../../styles/export-templates.css";

/**
 * Full-screen Preferences modal.
 *
 * Rendered at the Shell level so it floats above all app chrome.
 * Visibility is controlled by `useUiStore.settingsOpen`.
 *
 * Sections (each lives in `./sections/`):
 *   1. Appearance         — theme, font size, content width, agent notifications
 *   2. Command-line tool   — installs the `mdopen` CLI via Tauri IPC
 *   3. Default Markdown app — set/verify Ashlr MD as the `.md` handler
 *   4. Vault               — Obsidian vault-root override
 *   5. AI memory           — local, editable facts injected into chats
 *   6. Semantic search     — on-device embedding index status
 *   7. AI agents (MCP)     — one-click agent connect + manual setup command
 */
export function SettingsPanel() {
  const close = useUiStore((s) => s.closeSettings);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape (capture phase so it beats inner key handlers), but not
  // on one that ends an IME composition in a field (see isDismissEscape).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isDismissEscape(e)) {
        e.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  // Trap focus inside the panel (Tab cycling) and restore focus to the trigger
  // on close. Replaces the prior "focus first element on open" one-liner.
  useFocusTrap(panelRef);

  return (
    /* Backdrop — click outside to close */
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        ref={panelRef}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="settings-header">
          <h2 className="settings-title" id="settings-panel-title">
            Preferences
          </h2>
          <button
            type="button"
            className="settings-close-btn"
            onClick={close}
            aria-label="Close preferences"
          >
            <CloseIcon />
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="settings-body">
          {/* 1 · Appearance */}
          <section className="settings-section">
            <SectionHeader icon={<AppearanceIcon />} title="Appearance" />

            <div className="settings-row">
              <span className="settings-label">Theme</span>
              <ThemePicker />
            </div>

            <div className="settings-row">
              <span className="settings-label">Font size</span>
              <FontSizeStepper />
            </div>

            <div className="settings-row">
              <span className="settings-label">Content width</span>
              <ContentWidthStepper />
            </div>

            <div className="settings-row">
              <span className="settings-label">Agent notifications</span>
              <NotificationToggle />
            </div>

            <div className="settings-row">
              <span className="settings-label">Load remote images</span>
              <RemoteImagesToggle />
            </div>
          </section>

          <div className="settings-divider" />

          {/* 2 · Command-line tool */}
          <section className="settings-section">
            <SectionHeader icon={<TerminalIcon />} title="Command-line tool" />
            <CliSection />
          </section>

          <div className="settings-divider" />

          {/* 3 · Default Markdown app */}
          <section className="settings-section">
            <SectionHeader icon={<LinkIcon />} title="Default Markdown app" />
            <DefaultHandlerSection />
          </section>

          <div className="settings-divider" />

          {/* 4 · Vault */}
          <section className="settings-section">
            <SectionHeader icon={<VaultIcon />} title="Vault" />
            <VaultSection />
          </section>

          <div className="settings-divider" />

          {/* 5 · AI memory */}
          <section className="settings-section">
            <SectionHeader icon={<MemoryIcon />} title="AI memory" />
            <MemorySection />
          </section>

          <div className="settings-divider" />

          {/* 6 · Semantic search */}
          <section className="settings-section">
            <SectionHeader icon={<DatabaseIcon />} title="Semantic search" />
            <EmbedSection />
          </section>

          <div className="settings-divider" />

          {/* 7 · AI agents (MCP) */}
          <section className="settings-section">
            <SectionHeader icon={<AgentIcon />} title="AI agents (MCP)" />
            <McpSection />
          </section>

          <div className="settings-divider" />

          {/* Anthropic API key (Tier 2): replace or remove a saved key */}
          <section className="settings-section">
            <SectionHeader icon={<AgentIcon />} title="Anthropic API key" />
            <AnthropicKeySection />
          </section>

          <div className="settings-divider" />

          {/* 8 · Hosted AI provider (Tier 3) */}
          <section className="settings-section">
            <SectionHeader icon={<AgentIcon />} title="Hosted AI (Tier 3)" />
            <AiProviderSection />
          </section>

          <div className="settings-divider" />

          {/* 9 · AI provider metrics */}
          <section className="settings-section">
            <SectionHeader icon={<ChartIcon />} title="AI Metrics" />
            <AiMetricsSection />
          </section>

          <div className="settings-divider" />

          {/* 9 · Export templates */}
          <section className="settings-section">
            <SectionHeader icon={<ExportIcon />} title="Export templates" />
            <ExportTemplateSection />
          </section>

          <div className="settings-divider" />

          {/* 10 · Linter rules */}
          <section className="settings-section">
            <SectionHeader icon={<LinterIcon />} title="Linter rules" />
            <LinterRulesSection />
          </section>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div className="settings-footer">
          <button type="button" className="settings-done-btn" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
