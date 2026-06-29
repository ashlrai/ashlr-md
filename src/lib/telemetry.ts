// On-device provider metrics telemetry.
//
// Privacy-preserving, local-only: all data stays in localStorage under the
// key "mdopener-provider-metrics". No network calls, no PII — only provider
// tier/id labels and aggregate counters/latencies are stored.
//
// Designed for the Settings dashboard to show the user which AI tier was
// picked most often, average response latencies, and error rates.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderMetricEntry {
  /** Provider id — e.g. "apple-fm" | "ollama" | "anthropic" | "hosted" */
  providerId: string;
  /** Tier number 0-3 */
  tier: number;
  /** Total number of successful generations */
  successCount: number;
  /** Total number of failed generations (includes aborts) */
  failureCount: number;
  /** Total number of user-initiated aborts */
  abortCount: number;
  /** Running sum of successful-generation latencies (ms) — divide by successCount for avg */
  totalLatencyMs: number;
  /** Timestamp (ms) of the most recent generation attempt */
  lastUsedAt: number;
}

export interface ProviderMetrics {
  /** Per-provider aggregates keyed by providerId */
  providers: Record<string, ProviderMetricEntry>;
  /** Schema version — bump when shape changes so old data can be migrated */
  version: 1;
}

// ---------------------------------------------------------------------------
// Storage key
// ---------------------------------------------------------------------------

export const METRICS_STORAGE_KEY = "mdopener-provider-metrics";

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

/** Load the current metrics from localStorage, or return an empty scaffold. */
export function loadMetrics(): ProviderMetrics {
  try {
    const raw = localStorage.getItem(METRICS_STORAGE_KEY);
    if (!raw) return emptyMetrics();
    const parsed = JSON.parse(raw) as Partial<ProviderMetrics>;
    if (parsed.version !== 1 || typeof parsed.providers !== "object") {
      return emptyMetrics();
    }
    return parsed as ProviderMetrics;
  } catch {
    return emptyMetrics();
  }
}

/** Persist metrics to localStorage. */
export function saveMetrics(metrics: ProviderMetrics): void {
  try {
    localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(metrics));
  } catch {
    // Storage quota exceeded or unavailable — skip silently.
  }
}

/** Clear all stored metrics. */
export function clearMetrics(): void {
  try {
    localStorage.removeItem(METRICS_STORAGE_KEY);
  } catch {
    // Unavailable — ignore.
  }
}

function emptyMetrics(): ProviderMetrics {
  return { version: 1, providers: {} };
}

function ensureEntry(
  metrics: ProviderMetrics,
  providerId: string,
  tier: number,
): ProviderMetricEntry {
  if (!metrics.providers[providerId]) {
    metrics.providers[providerId] = {
      providerId,
      tier,
      successCount: 0,
      failureCount: 0,
      abortCount: 0,
      totalLatencyMs: 0,
      lastUsedAt: 0,
    };
  }
  return metrics.providers[providerId];
}

// ---------------------------------------------------------------------------
// Recording helpers (called by registry / AISidebar after each generation)
// ---------------------------------------------------------------------------

/**
 * Record a successful generation.
 *
 * @param providerId  e.g. "ollama"
 * @param tier        0-3
 * @param latencyMs   Wall-clock time from first-token to last-token (ms)
 */
export function recordSuccess(providerId: string, tier: number, latencyMs: number): void {
  const metrics = loadMetrics();
  const entry = ensureEntry(metrics, providerId, tier);
  entry.successCount += 1;
  entry.totalLatencyMs += latencyMs;
  entry.lastUsedAt = Date.now();
  saveMetrics(metrics);
}

/**
 * Record a failed generation (network error, provider refused, etc.).
 * Aborted requests should use {@link recordAbort} instead.
 */
export function recordFailure(providerId: string, tier: number): void {
  const metrics = loadMetrics();
  const entry = ensureEntry(metrics, providerId, tier);
  entry.failureCount += 1;
  entry.lastUsedAt = Date.now();
  saveMetrics(metrics);
}

/**
 * Record a user-initiated abort (Stop button / sidebar close / Esc).
 * Also increments failureCount so the abort rate is visible in totals.
 */
export function recordAbort(providerId: string, tier: number): void {
  const metrics = loadMetrics();
  const entry = ensureEntry(metrics, providerId, tier);
  entry.abortCount += 1;
  entry.failureCount += 1;
  entry.lastUsedAt = Date.now();
  saveMetrics(metrics);
}

// ---------------------------------------------------------------------------
// Derived helpers for the Settings dashboard
// ---------------------------------------------------------------------------

/** Average latency in ms for a provider, or 0 if no successful generations. */
export function averageLatencyMs(entry: ProviderMetricEntry): number {
  if (entry.successCount === 0) return 0;
  return entry.totalLatencyMs / entry.successCount;
}

/** Success rate as a value between 0 and 1 (excludes aborts from denominator). */
export function successRate(entry: ProviderMetricEntry): number {
  const total = entry.successCount + entry.failureCount;
  if (total === 0) return 0;
  return entry.successCount / total;
}

/** Return all entries sorted by most-recently-used first. */
export function sortedMetricEntries(metrics: ProviderMetrics): ProviderMetricEntry[] {
  return Object.values(metrics.providers).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}
