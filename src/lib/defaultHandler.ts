/**
 * defaultHandler.ts — typed wrappers around the Tauri `default_handler` commands.
 *
 * All functions are safe to call in any environment:
 *   - In `tauri dev` (unbundled) `isDefaultMdHandler` returns false and
 *     `setDefaultMdHandler` rejects with a friendly message.
 *   - In a production `.app` build they drive the `mdopener-setdefault` helper.
 */

import { invoke } from "@tauri-apps/api/core";

/** Tri-state default-handler status (mirrors the Rust `DefaultHandlerStatus`). */
export interface DefaultHandlerStatus {
  /** `"default"` | `"not-default"` | `"unknown"`. */
  state: "default" | "not-default" | "unknown";
  /** Machine-readable reason, e.g. `"ok"`, `"helper-missing"`, `"dev-unbundled"`. */
  reason: string;
  /** Whether `setDefaultMdHandler` can plausibly succeed in this environment. */
  canSet: boolean;
}

/**
 * Tri-state check of whether Ashlr MD is the default `.md` handler.
 *
 * Unlike {@link isDefaultMdHandler}, this distinguishes "definitely not the
 * default" from "could not determine" — so the UI only prompts on a definitive
 * `not-default`, never when detection simply failed.  Never throws.
 */
export async function defaultHandlerStatus(): Promise<DefaultHandlerStatus> {
  try {
    return await invoke<DefaultHandlerStatus>("default_handler_status");
  } catch {
    return { state: "unknown", reason: "ipc-error", canSet: false };
  }
}

/**
 * Check whether Ashlr MD is currently the default app for `.md` files.
 *
 * Never throws — returns `false` on any error so the UI always has a safe value.
 */
export async function isDefaultMdHandler(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_default_md_handler");
  } catch {
    // Gracefully degrade; the banner simply won't show in unusual environments.
    return false;
  }
}

/**
 * Register Ashlr MD as the default app for all Markdown extensions
 * (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`).
 *
 * @throws {string} Human-readable error message if the operation fails.
 */
export async function setDefaultMdHandler(): Promise<void> {
  await invoke<void>("set_default_md_handler");
}

/**
 * Open the macOS System Settings pane (or Finder "Get Info" guidance) so the
 * user can manually set the default app.  Never throws.
 */
export async function openDefaultAppsHelp(): Promise<void> {
  try {
    await invoke<void>("open_default_apps_help");
  } catch {
    // Swallow — this is a best-effort helper.
  }
}
