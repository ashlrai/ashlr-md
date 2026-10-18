import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { NOT_DETECTED } from "./McpSection";
import source from "./McpSection.tsx?raw";

// A disabled Connect button used to explain itself only as "Claude Code CLI
// not found", "Cursor not detected" or "Codex CLI not found", with no next
// step, and only in a tooltip.
describe("McpSection: tools that are not detected", () => {
  it("each reason says how to install the tool and to reopen Preferences", () => {
    expect(NOT_DETECTED.claude).toContain("https://claude.ai/download");
    expect(NOT_DETECTED.codex).toContain("npm i -g @openai/codex");
    expect(NOT_DETECTED.cursor).toContain("Install Cursor");
    for (const reason of Object.values(NOT_DETECTED)) {
      expect(reason).toMatch(/then close and reopen Preferences\.$/);
      expect(reason).not.toContain("—");
    }
  });

  it("is the button's tooltip and a visible note", () => {
    for (const tool of ["claude", "cursor", "codex"] as const) {
      expect(source).toContain(
        `agentClis?.${tool} === false\n              ? NOT_DETECTED.${tool}`,
      );
    }
    expect(source).toContain("{NOT_DETECTED[tool]}");
  });
});
