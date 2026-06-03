import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

/**
 * Check GitHub Releases for a newer signed build. If one exists, ask the user
 * (never auto-installs silently), then download, install, and relaunch.
 *
 * No-ops gracefully in dev / unpackaged builds / offline — the catch swallows
 * the "not an updater-enabled bundle" error.
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;

    const yes = await ask(`Ashlr MD ${update.version} is available. Install it now?`, {
      title: "Update available",
      kind: "info",
      okLabel: "Install",
      cancelLabel: "Later",
    });
    if (!yes) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch {
    /* no update server, offline, or running unpackaged — ignore */
  }
}
