// Shared async-status shapes used by the settings sections.

/**
 * Tracks the async state of a fire-once Tauri command (e.g. `install_cli`,
 * `setDefaultMdHandler`).
 * `idle`    — not yet invoked
 * `busy`    — invocation in flight
 * `ok`      — succeeded; `path` holds an optional install location
 * `error`   — failed; `message` describes why
 */
export type InstallStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; path: string }
  | { kind: "error"; message: string };
