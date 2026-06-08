import { THEMES, useSettingsStore } from "../../../store/settingsStore";
import { MinusIcon, PlusIcon } from "../icons";

// ─── Theme swatch row ─────────────────────────────────────────────────────────

/**
 * Three-swatch segmented control for theme selection.
 * Each swatch shows a tiny colour preview so the choice is visually obvious.
 */
const THEME_SWATCHES: Record<string, { bg: string; text: string; accent: string }> = {
  paper: { bg: "#ffffff", text: "#1f2328", accent: "#0969da" },
  sepia: { bg: "#f5edda", text: "#43382a", accent: "#9a5b34" },
  midnight: { bg: "#16181d", text: "#e6e8eb", accent: "#6ba8ff" },
};

export function ThemePicker() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="settings-theme-picker" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => {
        const swatch = THEME_SWATCHES[t.id];
        const active = theme === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`settings-theme-btn${active ? " active" : ""}`}
            onClick={() => setTheme(t.id)}
            title={`Switch to ${t.label} theme`}
          >
            {/* Mini colour preview */}
            <span
              className="settings-theme-swatch"
              style={{ background: swatch.bg }}
              aria-hidden="true"
            >
              <span
                className="settings-theme-swatch-text"
                style={{ color: swatch.text }}
              />
              <span
                className="settings-theme-swatch-accent"
                style={{ background: swatch.accent }}
              />
            </span>
            <span className="settings-theme-label">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Font-size stepper ────────────────────────────────────────────────────────

const FONT_MIN = 13;
const FONT_MAX = 24;

export function FontSizeStepper() {
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);

  return (
    <div className="settings-stepper" role="group" aria-label="Font size">
      <button
        type="button"
        className="settings-stepper-btn"
        onClick={() => setFontSize(fontSize - 1)}
        disabled={fontSize <= FONT_MIN}
        aria-label="Decrease font size"
      >
        <MinusIcon />
      </button>
      <span className="settings-stepper-value" aria-live="polite" aria-atomic="true">
        {fontSize}
        <span className="settings-stepper-unit">px</span>
      </span>
      <button
        type="button"
        className="settings-stepper-btn"
        onClick={() => setFontSize(fontSize + 1)}
        disabled={fontSize >= FONT_MAX}
        aria-label="Increase font size"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

// ─── Content-width stepper ──────────────────────────────────────────────────

const WIDTH_MIN = 600;
const WIDTH_MAX = 960;
const WIDTH_STEP = 40;

export function ContentWidthStepper() {
  const contentWidth = useSettingsStore((s) => s.contentWidth);
  const setContentWidth = useSettingsStore((s) => s.setContentWidth);

  return (
    <div className="settings-stepper" role="group" aria-label="Content width">
      <button
        type="button"
        className="settings-stepper-btn"
        onClick={() => setContentWidth(contentWidth - WIDTH_STEP)}
        disabled={contentWidth <= WIDTH_MIN}
        aria-label="Narrower content"
      >
        <MinusIcon />
      </button>
      <span className="settings-stepper-value" aria-live="polite" aria-atomic="true">
        {contentWidth}
        <span className="settings-stepper-unit">px</span>
      </span>
      <button
        type="button"
        className="settings-stepper-btn"
        onClick={() => setContentWidth(contentWidth + WIDTH_STEP)}
        disabled={contentWidth >= WIDTH_MAX}
        aria-label="Wider content"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

// ─── Notifications toggle ─────────────────────────────────────────────────────

export function NotificationToggle() {
  const enabled = useSettingsStore((s) => s.notificationsEnabled);
  const setEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`settings-switch${enabled ? " on" : ""}`}
      onClick={() => setEnabled(!enabled)}
      title={
        enabled
          ? "Notify me when an agent writes files while Ashlr isn't focused"
          : "Native notifications are off"
      }
    >
      <span className="settings-switch-knob" aria-hidden="true" />
      <span className="settings-switch-label">{enabled ? "On" : "Off"}</span>
    </button>
  );
}
