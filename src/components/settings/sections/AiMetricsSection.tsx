// Settings section — AI Provider Metrics dashboard.
//
// Displays per-provider usage distribution (pie chart), average latency
// (bar chart), error rates, and a "Clear metrics" button.
// All data is read from localStorage via the telemetry module — local-only,
// no network calls, no PII.

import { useCallback, useEffect, useState } from "react";
import {
  averageLatencyMs,
  clearMetrics,
  loadMetrics,
  sortedMetricEntries,
  successRate,
  type ProviderMetricEntry,
  type ProviderMetrics,
} from "../../../lib/telemetry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROVIDER_COLORS: Record<string, string> = {
  "apple-fm": "#34c759",
  ollama: "#007aff",
  anthropic: "#d97706",
  hosted: "#8b5cf6",
};

function providerColor(id: string): string {
  return PROVIDER_COLORS[id] ?? "#6b7280";
}

function tierLabel(tier: number): string {
  switch (tier) {
    case 0: return "Tier 0 · On-device";
    case 1: return "Tier 1 · Local";
    case 2: return "Tier 2 · Cloud (BYO key)";
    case 3: return "Tier 3 · Hosted";
    default: return `Tier ${tier}`;
  }
}

function fmtMs(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// ---------------------------------------------------------------------------
// Mini SVG pie chart (no external dep)
// ---------------------------------------------------------------------------

interface PieSlice {
  providerId: string;
  value: number;
  color: string;
}

function buildPieSlices(entries: ProviderMetricEntry[]): PieSlice[] {
  const total = entries.reduce((s, e) => s + e.successCount + e.failureCount, 0);
  if (total === 0) return [];
  return entries.map((e) => ({
    providerId: e.providerId,
    value: (e.successCount + e.failureCount) / total,
    color: providerColor(e.providerId),
  }));
}

/** Compute SVG arc path for a pie slice. */
function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const x1 = cx + r * Math.cos(toRad(startAngle));
  const y1 = cy + r * Math.sin(toRad(startAngle));
  const x2 = cx + r * Math.cos(toRad(endAngle));
  const y2 = cy + r * Math.sin(toRad(endAngle));
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

function PieChart({ slices }: { slices: PieSlice[] }) {
  if (slices.length === 0) {
    return (
      <svg width="80" height="80" viewBox="0 0 80 80" aria-label="No data">
        <circle cx="40" cy="40" r="35" fill="none" stroke="var(--color-border)" strokeWidth="1.5" />
        <text x="40" y="44" textAnchor="middle" fontSize="9" fill="var(--color-text-muted)">
          No data
        </text>
      </svg>
    );
  }

  // Single provider — full circle.
  if (slices.length === 1) {
    return (
      <svg width="80" height="80" viewBox="0 0 80 80" aria-label="Usage distribution">
        <circle cx="40" cy="40" r="35" fill={slices[0].color} />
      </svg>
    );
  }

  let currentAngle = -90; // start at top
  const paths = slices.map((slice) => {
    const sweep = slice.value * 360;
    const path = arcPath(40, 40, 35, currentAngle, currentAngle + sweep);
    currentAngle += sweep;
    return <path key={slice.providerId} d={path} fill={slice.color} />;
  });

  return (
    <svg width="80" height="80" viewBox="0 0 80 80" aria-label="Usage distribution">
      {paths}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Mini bar chart for latency
// ---------------------------------------------------------------------------

function LatencyBar({
  entry,
  maxMs,
}: {
  entry: ProviderMetricEntry;
  maxMs: number;
}) {
  const avg = averageLatencyMs(entry);
  const widthPct = maxMs > 0 ? (avg / maxMs) * 100 : 0;
  const color = providerColor(entry.providerId);

  return (
    <div className="ai-metrics-bar-row" aria-label={`${entry.providerId} avg latency ${fmtMs(avg)}`}>
      <span className="ai-metrics-bar-label">{entry.providerId}</span>
      <div className="ai-metrics-bar-track">
        <div
          className="ai-metrics-bar-fill"
          style={{ width: `${widthPct}%`, background: color }}
        />
      </div>
      <span className="ai-metrics-bar-value">{fmtMs(avg)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section component
// ---------------------------------------------------------------------------

export function AiMetricsSection() {
  const [metrics, setMetrics] = useState<ProviderMetrics>(() => loadMetrics());

  // Refresh on mount and whenever this section re-mounts (settings re-open).
  useEffect(() => {
    setMetrics(loadMetrics());
  }, []);

  const handleClear = useCallback(() => {
    clearMetrics();
    setMetrics(loadMetrics());
  }, []);

  const entries = sortedMetricEntries(metrics);
  const pieSlices = buildPieSlices(entries);
  const maxLatency = entries.reduce((m, e) => Math.max(m, averageLatencyMs(e)), 0);
  const hasData = entries.length > 0;

  return (
    <div className="ai-metrics-section">
      {!hasData && (
        <p className="settings-description ai-metrics-empty">
          No AI usage recorded yet. Run an inline action (⌘I) or use the AI sidebar to
          generate some data.
        </p>
      )}

      {hasData && (
        <>
          {/* ── Row 1: pie + legend ─────────────────────────────────────── */}
          <div className="ai-metrics-top-row">
            <div className="ai-metrics-pie-wrap">
              <PieChart slices={pieSlices} />
              <p className="ai-metrics-pie-caption">Usage distribution</p>
            </div>

            <div className="ai-metrics-legend">
              {entries.map((e) => {
                const total = e.successCount + e.failureCount;
                const slice = pieSlices.find((s) => s.providerId === e.providerId);
                return (
                  <div key={e.providerId} className="ai-metrics-legend-row">
                    <span
                      className="ai-metrics-legend-dot"
                      style={{ background: slice?.color ?? "#6b7280" }}
                      aria-hidden="true"
                    />
                    <div className="ai-metrics-legend-text">
                      <span className="ai-metrics-legend-name">{e.providerId}</span>
                      <span className="ai-metrics-legend-tier">{tierLabel(e.tier)}</span>
                    </div>
                    <span className="ai-metrics-legend-count">{total} calls</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Row 2: latency bars ─────────────────────────────────────── */}
          <div className="ai-metrics-card">
            <h4 className="ai-metrics-card-title">Avg latency per provider</h4>
            <div className="ai-metrics-bars">
              {entries.map((e) => (
                <LatencyBar key={e.providerId} entry={e} maxMs={maxLatency} />
              ))}
            </div>
          </div>

          {/* ── Row 3: error rate table ─────────────────────────────────── */}
          <div className="ai-metrics-card">
            <h4 className="ai-metrics-card-title">Success / error rates</h4>
            <table className="ai-metrics-table" aria-label="Provider success rates">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Success</th>
                  <th>Failures</th>
                  <th>Aborts</th>
                  <th>Rate</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.providerId}>
                    <td>
                      <span
                        className="ai-metrics-legend-dot"
                        style={{ background: providerColor(e.providerId) }}
                        aria-hidden="true"
                      />
                      {e.providerId}
                    </td>
                    <td>{e.successCount}</td>
                    <td>{e.failureCount - e.abortCount}</td>
                    <td>{e.abortCount}</td>
                    <td>{pct(successRate(e))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Clear button — always visible ─────────────────────────────── */}
      <div className="ai-metrics-footer">
        <button
          type="button"
          className="settings-action-btn settings-action-btn-secondary"
          onClick={handleClear}
          disabled={!hasData}
          aria-label="Clear all AI provider metrics"
        >
          Clear metrics
        </button>
        {hasData && (
          <span className="ai-metrics-footer-hint">
            {entries.length} provider{entries.length !== 1 ? "s" : ""} tracked
          </span>
        )}
      </div>
    </div>
  );
}
