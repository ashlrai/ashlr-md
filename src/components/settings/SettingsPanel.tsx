import { useEffect, useRef } from "react";
import { useUiStore } from "../../store/uiStore";
import {
  AgentIcon,
  AppearanceIcon,
  CloseIcon,
  DatabaseIcon,
  LinkIcon,
  MemoryIcon,
  TerminalIcon,
  VaultIcon,
} from "./icons";
import { SectionHeader } from "./SectionHeader";
import {
  ContentWidthStepper,
  FontSizeStepper,
  NotificationToggle,
  ThemePicker,
} from "./sections/AppearanceControls";
import { CliSection } from "./sections/CliSection";
import { DefaultHandlerSection } from "./sections/DefaultHandlerSection";
import { EmbedSection } from "./sections/EmbedSection";
import { McpSection } from "./sections/McpSection";
import { MemorySection } from "./sections/MemorySection";
import { VaultSection } from "./sections/VaultSection";
import "../../styles/settings.css";

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

  // Close on Escape (capture phase so it beats inner key handlers).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  // Trap focus: move to first focusable element on open.
  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>(
      "button:not(:disabled), [tabindex='0']",
    );
    first?.focus();
  }, []);

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
              <label className="settings-label">Theme</label>
              <ThemePicker />
            </div>

            <div className="settings-row">
              <label className="settings-label">Font size</label>
              <FontSizeStepper />
            </div>

            <div className="settings-row">
              <label className="settings-label">Content width</label>
              <ContentWidthStepper />
            </div>

            <div className="settings-row">
              <label className="settings-label">Agent notifications</label>
              <NotificationToggle />
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
