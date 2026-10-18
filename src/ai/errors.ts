// Provider error mapping: turns the raw text a provider fails with
// ("Anthropic error 401 Unauthorized: {json}", "Ollama request failed: ...",
// "Hosted provider: invalid or expired token (401)") into a plain message that
// names the next step. The raw text is kept as `detail` so the UI can show it
// as a secondary, collapsed line.
//
// Shared by every AI surface: the sidebar chat and quick actions, the
// selection popover, and the editors' inline transforms.

export interface AIErrorInfo {
  /** One or two plain sentences: what went wrong and what to do next. */
  message: string;
  /** A shell command the next step needs, shown as code (e.g. `ollama serve`). */
  command?: string;
  /** The provider's raw error text, for the secondary "Details" line. */
  detail: string;
}

/**
 * What every AI surface says when no provider is found: the editors' inline
 * AI and the selection popover alike.
 */
export const NO_PROVIDER_MESSAGE = "No AI provider. Set one up in the AI sidebar.";

/**
 * What the selection popover leaves in the AI sidebar when no provider is
 * found. The popover opens the sidebar, which then shows its setup panel
 * with this message on top (AISidebar's SetupNudge), so it points at the
 * panel's options instead of at "the AI sidebar" the user is already in.
 */
export const NO_PROVIDER_RUN_MESSAGE =
  "No AI provider was found, so this did not run. Set one up here, then select the text and try again.";

/** Whether the app runs on macOS, read at call time. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/.test(navigator.platform || navigator.userAgent || "");
}

/**
 * How to get an AI provider, true for the platform: the on-device model
 * exists only on a Mac (Apple Silicon, macOS 26 or later, Apple Intelligence
 * on), so Windows and Linux are pointed at Ollama or a key. The README's
 * quick start says the same (docFacts.test.ts holds the two together).
 */
export function noProviderSetupHint(mac: boolean = isMacPlatform()): string {
  return mac
    ? "On a Mac with Apple Silicon and macOS 26 or later, turn on Apple Intelligence in System Settings, then restart Ashlr MD. Or install Ollama, or add an Anthropic API key in Preferences."
    : "Install Ollama for free local AI, or add an Anthropic API key in Preferences.";
}

/** The no-op provider's answer: no provider, and how to get one here. */
export function noProviderAnswer(mac: boolean = isMacPlatform()): string {
  return `No AI provider is available. ${noProviderSetupHint(mac)}`;
}

const NETWORK =
  /error sending request|failed to fetch|networkerror|network error|connection (refused|reset|closed)|dns error|could not resolve|stream read error|load failed/i;
const TIMEOUT = /timed out|timeout/i;

function rawText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function statusOf(raw: string): number | null {
  const m =
    /^(?:Anthropic|Ollama) error (\d{3})\b/.exec(raw) ??
    /request failed with status (\d{3})\b/.exec(raw) ??
    /\((\d{3})\)\s*$/.exec(raw);
  return m ? Number(m[1]) : null;
}

/**
 * Map a provider failure to a plain message with a next step. Never throws;
 * anything unrecognised gets a generic message with the raw text as detail.
 */
export function describeAIError(err: unknown): AIErrorInfo {
  const detail = rawText(err).trim();
  const raw = detail;
  const status = statusOf(raw);

  // ---- Ollama (local) ----------------------------------------------------
  if (/^Ollama/i.test(raw)) {
    if (/^Ollama request failed/i.test(raw) || NETWORK.test(raw)) {
      return {
        message:
          "Ollama is not running. Start it (open the Ollama app, or run the command below), then retry.",
        command: "ollama serve",
        detail,
      };
    }
    if (status === 404 || /model .*not found|no model detected/i.test(raw)) {
      return {
        message: "Ollama has no model to answer with. Pull one, then retry.",
        command: "ollama pull llama3.2",
        detail,
      };
    }
    return {
      message: "Ollama could not answer. Check that it is running, then retry.",
      command: "ollama serve",
      detail,
    };
  }

  // ---- Anthropic (bring your own key) ------------------------------------
  if (/^Anthropic/i.test(raw)) {
    if (/no API key configured/i.test(raw)) {
      return {
        message:
          "No Anthropic API key is saved. Add one in Preferences, Anthropic API key.",
        detail,
      };
    }
    if (
      status === 401 ||
      status === 403 ||
      /authentication_error|invalid x-api-key/i.test(raw)
    ) {
      return {
        message:
          "Anthropic rejected your API key: it is wrong, revoked or expired. Replace it in Preferences, Anthropic API key.",
        detail,
      };
    }
    if (status === 429 || /rate_limit_error/i.test(raw)) {
      return {
        message: "Anthropic is rate limiting your key. Wait a minute, then retry.",
        detail,
      };
    }
    if (/credit balance/i.test(raw)) {
      return {
        message:
          "Your Anthropic account is out of credit. Add credit in the Anthropic Console, then retry.",
        detail,
      };
    }
    if (status === 529 || /overloaded_error/i.test(raw)) {
      return {
        message: "Anthropic is overloaded right now. Wait a moment, then retry.",
        detail,
      };
    }
    if (status !== null && status >= 500) {
      return {
        message: "Anthropic had a server error. Wait a moment, then retry.",
        detail,
      };
    }
    if (/^Anthropic request failed/i.test(raw) || NETWORK.test(raw)) {
      return {
        message: TIMEOUT.test(raw)
          ? "Anthropic took too long to answer. Check your internet connection, then retry."
          : "Could not reach Anthropic. Check your internet connection, then retry.",
        detail,
      };
    }
  }

  // ---- Hosted (Ashlr MD Cloud) -------------------------------------------
  if (/^Hosted provider/i.test(raw)) {
    if (status === 401 || /invalid or expired token|no bearer token/i.test(raw)) {
      return {
        message:
          "Your Ashlr MD Cloud token is invalid or expired. Replace it in Preferences, Hosted AI.",
        detail,
      };
    }
    if (status === 429) {
      return {
        message: "Ashlr MD Cloud is rate limiting you. Wait a minute, then retry.",
        detail,
      };
    }
    if (status !== null && status >= 500) {
      return {
        message: "Ashlr MD Cloud had a server error. Wait a moment, then retry.",
        detail,
      };
    }
  }

  // ---- Apple Foundation Models (on-device) -------------------------------
  if (/Apple Foundation Models unavailable|mdopener-afm|afm sidecar/i.test(raw)) {
    return {
      message:
        "The on-device model is unavailable. Turn on Apple Intelligence in System Settings, then restart Ashlr MD.",
      detail,
    };
  }

  // ---- Generic network failures (e.g. the hosted fetch) ------------------
  if (NETWORK.test(raw) || TIMEOUT.test(raw)) {
    return {
      message:
        "Could not reach the AI service. Check your internet connection, then retry.",
      detail,
    };
  }

  return { message: "The AI request failed. Wait a moment, then retry.", detail };
}

/** describeAIError as one line, for surfaces with room for a single message. */
export function aiErrorLine(err: unknown): string {
  const info = describeAIError(err);
  return info.command ? `${info.message} (${info.command})` : info.message;
}
