// Unit tests for src/lib/telemetry.ts
// All tests use a fresh localStorage state (reset in beforeEach).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  averageLatencyMs,
  clearMetrics,
  loadMetrics,
  METRICS_STORAGE_KEY,
  recordAbort,
  recordFailure,
  recordSuccess,
  saveMetrics,
  sortedMetricEntries,
  successRate,
} from "./telemetry";

// ---------------------------------------------------------------------------
// Setup — wipe localStorage between every test
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// loadMetrics / saveMetrics
// ---------------------------------------------------------------------------

describe("loadMetrics()", () => {
  it("returns an empty scaffold when localStorage is empty", () => {
    const m = loadMetrics();
    expect(m.version).toBe(1);
    expect(m.providers).toEqual({});
  });

  it("returns an empty scaffold for malformed JSON", () => {
    localStorage.setItem(METRICS_STORAGE_KEY, "{invalid json{{");
    const m = loadMetrics();
    expect(m.providers).toEqual({});
  });

  it("returns an empty scaffold when version is not 1", () => {
    localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify({ version: 2, providers: {} }));
    const m = loadMetrics();
    expect(m.providers).toEqual({});
  });

  it("returns an empty scaffold when providers is missing", () => {
    localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify({ version: 1 }));
    const m = loadMetrics();
    expect(m.providers).toEqual({});
  });

  it("round-trips through saveMetrics/loadMetrics", () => {
    const metrics = loadMetrics();
    metrics.providers["ollama"] = {
      providerId: "ollama",
      tier: 1,
      successCount: 5,
      failureCount: 1,
      abortCount: 0,
      totalLatencyMs: 2500,
      lastUsedAt: 1000,
    };
    saveMetrics(metrics);
    const loaded = loadMetrics();
    expect(loaded.providers["ollama"].successCount).toBe(5);
    expect(loaded.providers["ollama"].totalLatencyMs).toBe(2500);
  });
});

describe("clearMetrics()", () => {
  it("removes the key from localStorage", () => {
    recordSuccess("ollama", 1, 100);
    clearMetrics();
    expect(localStorage.getItem(METRICS_STORAGE_KEY)).toBeNull();
  });

  it("subsequent loadMetrics returns empty scaffold after clear", () => {
    recordSuccess("anthropic", 2, 200);
    clearMetrics();
    const m = loadMetrics();
    expect(m.providers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// recordSuccess
// ---------------------------------------------------------------------------

describe("recordSuccess()", () => {
  it("creates a new entry on first call", () => {
    recordSuccess("ollama", 1, 300);
    const m = loadMetrics();
    expect(m.providers["ollama"]).toBeDefined();
    expect(m.providers["ollama"].successCount).toBe(1);
    expect(m.providers["ollama"].totalLatencyMs).toBe(300);
    expect(m.providers["ollama"].tier).toBe(1);
  });

  it("accumulates successCount and totalLatencyMs across calls", () => {
    recordSuccess("ollama", 1, 100);
    recordSuccess("ollama", 1, 200);
    recordSuccess("ollama", 1, 300);
    const m = loadMetrics();
    expect(m.providers["ollama"].successCount).toBe(3);
    expect(m.providers["ollama"].totalLatencyMs).toBe(600);
  });

  it("does not touch failureCount or abortCount", () => {
    recordSuccess("anthropic", 2, 500);
    const m = loadMetrics();
    expect(m.providers["anthropic"].failureCount).toBe(0);
    expect(m.providers["anthropic"].abortCount).toBe(0);
  });

  it("updates lastUsedAt to a recent timestamp", () => {
    const before = Date.now();
    recordSuccess("hosted", 3, 800);
    const after = Date.now();
    const m = loadMetrics();
    expect(m.providers["hosted"].lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(m.providers["hosted"].lastUsedAt).toBeLessThanOrEqual(after);
  });

  it("tracks multiple distinct providers independently", () => {
    recordSuccess("ollama", 1, 200);
    recordSuccess("anthropic", 2, 400);
    const m = loadMetrics();
    expect(m.providers["ollama"].successCount).toBe(1);
    expect(m.providers["anthropic"].successCount).toBe(1);
    expect(m.providers["ollama"].totalLatencyMs).toBe(200);
    expect(m.providers["anthropic"].totalLatencyMs).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// recordFailure
// ---------------------------------------------------------------------------

describe("recordFailure()", () => {
  it("increments failureCount", () => {
    recordFailure("anthropic", 2);
    const m = loadMetrics();
    expect(m.providers["anthropic"].failureCount).toBe(1);
  });

  it("does not touch successCount or abortCount", () => {
    recordFailure("ollama", 1);
    const m = loadMetrics();
    expect(m.providers["ollama"].successCount).toBe(0);
    expect(m.providers["ollama"].abortCount).toBe(0);
  });

  it("accumulates multiple failures", () => {
    recordFailure("ollama", 1);
    recordFailure("ollama", 1);
    const m = loadMetrics();
    expect(m.providers["ollama"].failureCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// recordAbort
// ---------------------------------------------------------------------------

describe("recordAbort()", () => {
  it("increments both abortCount and failureCount", () => {
    recordAbort("ollama", 1);
    const m = loadMetrics();
    expect(m.providers["ollama"].abortCount).toBe(1);
    expect(m.providers["ollama"].failureCount).toBe(1);
  });

  it("does not touch successCount", () => {
    recordAbort("hosted", 3);
    const m = loadMetrics();
    expect(m.providers["hosted"].successCount).toBe(0);
  });

  it("accumulates multiple aborts", () => {
    recordAbort("ollama", 1);
    recordAbort("ollama", 1);
    const m = loadMetrics();
    expect(m.providers["ollama"].abortCount).toBe(2);
    expect(m.providers["ollama"].failureCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// averageLatencyMs
// ---------------------------------------------------------------------------

describe("averageLatencyMs()", () => {
  it("returns 0 when there are no successes", () => {
    recordFailure("ollama", 1);
    const m = loadMetrics();
    expect(averageLatencyMs(m.providers["ollama"])).toBe(0);
  });

  it("returns the correct average", () => {
    recordSuccess("ollama", 1, 100);
    recordSuccess("ollama", 1, 300);
    const m = loadMetrics();
    expect(averageLatencyMs(m.providers["ollama"])).toBe(200);
  });

  it("returns exact value for a single success", () => {
    recordSuccess("anthropic", 2, 750);
    const m = loadMetrics();
    expect(averageLatencyMs(m.providers["anthropic"])).toBe(750);
  });
});

// ---------------------------------------------------------------------------
// successRate
// ---------------------------------------------------------------------------

describe("successRate()", () => {
  it("returns 0 when there are no attempts", () => {
    const entry = {
      providerId: "test",
      tier: 1,
      successCount: 0,
      failureCount: 0,
      abortCount: 0,
      totalLatencyMs: 0,
      lastUsedAt: 0,
    };
    expect(successRate(entry)).toBe(0);
  });

  it("returns 1 when all attempts succeeded", () => {
    recordSuccess("ollama", 1, 100);
    recordSuccess("ollama", 1, 200);
    const m = loadMetrics();
    expect(successRate(m.providers["ollama"])).toBe(1);
  });

  it("returns 0.5 for equal successes and failures", () => {
    recordSuccess("ollama", 1, 100);
    recordFailure("ollama", 1);
    const m = loadMetrics();
    expect(successRate(m.providers["ollama"])).toBe(0.5);
  });

  it("returns 0 when all attempts failed", () => {
    recordFailure("anthropic", 2);
    recordFailure("anthropic", 2);
    const m = loadMetrics();
    expect(successRate(m.providers["anthropic"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sortedMetricEntries
// ---------------------------------------------------------------------------

describe("sortedMetricEntries()", () => {
  it("returns an empty array when no metrics exist", () => {
    const m = loadMetrics();
    expect(sortedMetricEntries(m)).toEqual([]);
  });

  it("returns entries sorted by lastUsedAt descending", () => {
    // Use a mocked Date.now() to control timestamps
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1000);
    recordSuccess("ollama", 1, 100);
    nowSpy.mockReturnValue(3000);
    recordSuccess("anthropic", 2, 100);
    nowSpy.mockReturnValue(2000);
    recordSuccess("hosted", 3, 100);
    nowSpy.mockRestore();

    const m = loadMetrics();
    const entries = sortedMetricEntries(m);
    expect(entries[0].providerId).toBe("anthropic"); // lastUsedAt=3000
    expect(entries[1].providerId).toBe("hosted");    // lastUsedAt=2000
    expect(entries[2].providerId).toBe("ollama");    // lastUsedAt=1000
  });

  it("returns all providers", () => {
    recordSuccess("ollama", 1, 100);
    recordSuccess("anthropic", 2, 100);
    const m = loadMetrics();
    expect(sortedMetricEntries(m)).toHaveLength(2);
  });
});
