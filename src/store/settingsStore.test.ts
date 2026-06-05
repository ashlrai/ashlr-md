import { describe, expect, it } from "vitest";
import { isDefaultPromptSnoozed, NEVER_ASK_DEFAULT } from "./settingsStore";

describe("isDefaultPromptSnoozed", () => {
  it("treats null as not snoozed (prompt may show)", () => {
    expect(isDefaultPromptSnoozed(null)).toBe(false);
  });

  it("treats a future timestamp as snoozed", () => {
    expect(isDefaultPromptSnoozed(Date.now() + 60_000)).toBe(true);
  });

  it("treats a past timestamp as expired (prompt may show again)", () => {
    expect(isDefaultPromptSnoozed(Date.now() - 60_000)).toBe(false);
  });

  it("treats the never-ask sentinel as permanently snoozed", () => {
    expect(isDefaultPromptSnoozed(NEVER_ASK_DEFAULT)).toBe(true);
  });

  it("keeps the never-ask sentinel finite so it survives JSON serialization", () => {
    expect(Number.isFinite(NEVER_ASK_DEFAULT)).toBe(true);
    expect(JSON.parse(JSON.stringify(NEVER_ASK_DEFAULT))).toBe(NEVER_ASK_DEFAULT);
  });
});
