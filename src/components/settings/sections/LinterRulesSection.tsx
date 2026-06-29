/**
 * LinterRulesSection.tsx — Settings → Linter rules panel.
 *
 * Lets the user enable/disable individual lint rules. The four "toast rules"
 * (trailing-space, orphaned-heading, invalid-link-target, missing-alt-text) are
 * highlighted as "Default". All other built-in rules are listed below them.
 */

import {
  BUILTIN_RULES,
  LINTER_DEFAULT_ENABLED_RULES,
} from "../../../lib/mdlint";
import { useSettingsStore } from "../../../store/settingsStore";

function severityLabel(severity: string): string {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  return "Info";
}

function severityClass(severity: string): string {
  if (severity === "error") return "linter-rule__severity--error";
  if (severity === "warning") return "linter-rule__severity--warning";
  return "linter-rule__severity--info";
}

export function LinterRulesSection() {
  const linterConfig = useSettingsStore((s) => s.linterConfig);
  const toggleLinterRule = useSettingsStore((s) => s.toggleLinterRule);

  const defaultRuleIds = new Set(LINTER_DEFAULT_ENABLED_RULES);

  // Partition rules: toast-default rules first, then remaining built-ins.
  const defaultRules = BUILTIN_RULES.filter((r) => defaultRuleIds.has(r.id));
  const otherRules = BUILTIN_RULES.filter((r) => !defaultRuleIds.has(r.id));

  function isEnabled(ruleId: string): boolean {
    return !linterConfig.disabledRules.includes(ruleId);
  }

  function renderRule(rule: (typeof BUILTIN_RULES)[number], highlight: boolean) {
    const enabled = isEnabled(rule.id);
    return (
      <div
        key={rule.id}
        className={`linter-rule${highlight ? " linter-rule--default" : ""}${enabled ? "" : " linter-rule--disabled"}`}
      >
        <label className="linter-rule__label">
          <input
            type="checkbox"
            className="linter-rule__checkbox"
            checked={enabled}
            onChange={() => toggleLinterRule(rule.id)}
            aria-label={`${enabled ? "Disable" : "Enable"} rule: ${rule.label}`}
          />
          <span className="linter-rule__name">{rule.label}</span>
          {highlight && (
            <span className="linter-rule__badge">Default</span>
          )}
          <span className={`linter-rule__severity ${severityClass(rule.severity)}`}>
            {severityLabel(rule.severity)}
          </span>
        </label>
        <p className="linter-rule__description">{rule.description}</p>
      </div>
    );
  }

  return (
    <div className="linter-rules-section">
      <p className="settings-description">
        Rules marked <strong>Default</strong> show fix suggestions in the reading
        view. All enabled rules produce inline editor squiggles.
      </p>

      {defaultRules.length > 0 && (
        <div className="linter-rules-group">
          <p className="linter-rules-group__heading">Toast rules (reading view)</p>
          {defaultRules.map((r) => renderRule(r, true))}
        </div>
      )}

      {otherRules.length > 0 && (
        <div className="linter-rules-group">
          <p className="linter-rules-group__heading">Additional rules</p>
          {otherRules.map((r) => renderRule(r, false))}
        </div>
      )}
    </div>
  );
}
