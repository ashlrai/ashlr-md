// Provider errors reached the AI sidebar, the selection popover and the
// editors as raw text ("Anthropic error 401 Unauthorized: {json}", "Ollama
// request failed: ..."). describeAIError maps them to a plain next step and
// keeps the raw text as the secondary detail.
import { describe, expect, it } from "vitest";
import { aiErrorLine, describeAIError } from "./errors";

const ANTHROPIC_401 =
  'Anthropic error 401 Unauthorized: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

describe("describeAIError", () => {
  it("a rejected Anthropic key says to replace it in Preferences", () => {
    const info = describeAIError(new Error(ANTHROPIC_401));
    expect(info.message).toContain("rejected your API key");
    expect(info.message).toContain("Preferences, Anthropic API key");
    expect(info.message).not.toContain("{");
    expect(info.detail).toBe(ANTHROPIC_401);
  });

  it("Ollama not running names the start command", () => {
    const raw =
      "Ollama request failed: error sending request for url (http://localhost:11434/api/chat)";
    const info = describeAIError(new Error(raw));
    expect(info.message).toContain("Ollama is not running");
    expect(info.command).toBe("ollama serve");
    expect(info.detail).toBe(raw);
    expect(aiErrorLine(new Error(raw))).toContain("(ollama serve)");
  });

  it("a missing Ollama model names the pull command", () => {
    const info = describeAIError(
      new Error(
        'Ollama error 404 Not Found: {"error":"model \\"llama3.2\\" not found"}',
      ),
    );
    expect(info.command).toBe("ollama pull llama3.2");
  });

  it("an expired hosted token says to replace it", () => {
    const info = describeAIError(
      new Error("Hosted provider: invalid or expired token (401)"),
    );
    expect(info.message).toContain("invalid or expired");
    expect(info.message).toContain("Preferences, Hosted AI");
  });

  it("rate limits say to wait", () => {
    expect(
      describeAIError(new Error("Anthropic error 429 Too Many Requests: {}")).message,
    ).toContain("rate limiting");
    expect(
      describeAIError(new Error("Hosted provider: request failed with status 429"))
        .message,
    ).toContain("rate limiting");
    expect(
      describeAIError(
        new Error(
          'Anthropic stream error: {"type":"error","error":{"type":"rate_limit_error"}}',
        ),
      ).message,
    ).toContain("rate limiting");
  });

  it("network failures say to check the connection", () => {
    expect(
      describeAIError(
        new Error(
          "Anthropic request failed: error sending request for url (https://api.anthropic.com/v1/messages)",
        ),
      ).message,
    ).toContain("Check your internet connection");
    expect(describeAIError(new TypeError("Failed to fetch")).message).toContain(
      "Check your internet connection",
    );
  });

  it("anything else keeps the raw text as detail behind a plain message", () => {
    const info = describeAIError("something odd");
    expect(info.message).toBe("The AI request failed. Wait a moment, then retry.");
    expect(info.detail).toBe("something odd");
  });

  it("messages use no em-dashes", () => {
    for (const raw of [ANTHROPIC_401, "Ollama request failed: x", "zzz"]) {
      expect(describeAIError(new Error(raw)).message).not.toContain("—");
    }
  });
});
