/**
 * Obsidian plugin — Open in Ashlr MD
 *
 * Sends the active note (or any vault file) to Ashlr MD via the
 * `mdopener://open?path=<absolute-path>` URL scheme.
 *
 * Requires Ashlr MD to be installed so the URL scheme is registered.
 * Desktop-only (isDesktopOnly: true in manifest.json).
 */

import {
	App,
	FileSystemAdapter,
	Menu,
	MenuItem,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
} from "obsidian";

// ─── Settings ────────────────────────────────────────────────────────────────

interface AshlrMdSettings {
	/** When true, open files in edit mode by default. */
	openInEditMode: boolean;
}

const DEFAULT_SETTINGS: AshlrMdSettings = {
	openInEditMode: false,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the absolute on-disk path for a vault-relative TFile path.
 * Returns null (and shows a Notice) if the vault adapter is not a
 * FileSystemAdapter — e.g. a remote/sync vault that has no local root.
 */
function getAbsolutePath(app: App, file: TFile): string | null {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		new Notice(
			"Open in Ashlr MD: this vault does not expose a local file path.\n" +
				"Ashlr MD can only open files stored on the local file system."
		);
		return null;
	}
	// basePath does not have a trailing slash; file.path is always forward-slash.
	return `${adapter.getBasePath()}/${file.path}`;
}

/**
 * Builds the `mdopener://open` URL for the given absolute path and mode.
 * The path is percent-encoded so spaces and special characters are safe.
 */
function buildUrl(absolutePath: string, mode?: "read" | "edit"): string {
	const encodedPath = encodeURIComponent(absolutePath);
	const modeParam = mode ? `&mode=${mode}` : "";
	return `mdopener://open?path=${encodedPath}${modeParam}`;
}

/**
 * Opens `url` using Electron's shell.openExternal, which correctly handles
 * custom URL schemes on macOS.  Falls back to window.open if Electron is
 * somehow unavailable (shouldn't happen in the desktop app).
 */
async function openUrl(url: string): Promise<void> {
	try {
		// Electron is always present in the Obsidian desktop app.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { shell } = require("electron") as typeof import("electron");
		await shell.openExternal(url);
	} catch {
		// Graceful fallback — e.g. running tests outside Electron.
		window.open(url);
	}
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class AshlrMdPlugin extends Plugin {
	settings: AshlrMdSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		// ── Ribbon icon ──────────────────────────────────────────────────────
		this.addRibbonIcon("external-link", "Open in Ashlr MD", () => {
			this.openActiveFile();
		});

		// ── Commands ─────────────────────────────────────────────────────────

		// Command 1: open with the user's default mode preference.
		this.addCommand({
			id: "open-current",
			name: "Open current note in Ashlr MD",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.openFile(file);
				return true;
			},
		});

		// Command 2: always open in edit mode, regardless of the setting.
		this.addCommand({
			id: "open-current-edit",
			name: "Open current note in Ashlr MD (edit mode)",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.openFile(file, "edit");
				return true;
			},
		});

		// ── File-explorer context menu ────────────────────────────────────────
		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(menu: Menu, file: TAbstractFile) => {
					// Only show for actual files, not folders.
					if (!(file instanceof TFile)) return;

					menu.addItem((item: MenuItem) => {
						item
							.setTitle("Open in Ashlr MD")
							.setIcon("external-link")
							.setSection("open")
							.onClick(() => this.openFile(file));
					});
				}
			)
		);

		// ── Editor context menu ───────────────────────────────────────────────
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return;

				menu.addItem((item: MenuItem) => {
					item
						.setTitle("Open in Ashlr MD")
						.setIcon("external-link")
						.setSection("open")
						.onClick(() => this.openFile(file));
				});
			})
		);

		// ── Settings tab ──────────────────────────────────────────────────────
		this.addSettingTab(new AshlrMdSettingTab(this.app, this));
	}

	onunload(): void {
		// Nothing to clean up beyond what Obsidian handles automatically.
	}

	// ── Core open logic ───────────────────────────────────────────────────────

	/**
	 * Opens the currently active file. Shows a Notice if there is none.
	 */
	private openActiveFile(): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("Open in Ashlr MD: no active file.");
			return;
		}
		this.openFile(file);
	}

	/**
	 * Opens `file` in Ashlr MD.
	 *
	 * @param file   The TFile to open.
	 * @param mode   Override the mode for this call. When omitted the plugin
	 *               setting determines whether to add `&mode=edit`.
	 */
	private openFile(file: TFile, mode?: "read" | "edit"): void {
		const absolutePath = getAbsolutePath(this.app, file);
		if (!absolutePath) return; // Notice already shown.

		const resolvedMode: "edit" | "read" | undefined =
			mode ?? (this.settings.openInEditMode ? "edit" : undefined);

		const url = buildUrl(absolutePath, resolvedMode);
		openUrl(url).catch((err: unknown) => {
			console.error("Ashlr MD plugin: failed to open URL", url, err);
			new Notice(
				"Open in Ashlr MD: could not launch the app.\n" +
					"Make sure Ashlr MD is installed (https://md.ashlr.ai)."
			);
		});
	}

	// ── Persistence ──────────────────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

// ─── Settings tab ────────────────────────────────────────────────────────────

class AshlrMdSettingTab extends PluginSettingTab {
	plugin: AshlrMdPlugin;

	constructor(app: App, plugin: AshlrMdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Open in Ashlr MD" });

		new Setting(containerEl)
			.setName("Open in edit mode by default")
			.setDesc(
				"When enabled, notes are opened in Ashlr MD's WYSIWYG editor " +
					"instead of read view. You can still use the dedicated " +
					'"Open in edit mode" command to force edit mode on a per-note basis.'
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openInEditMode)
					.onChange(async (value: boolean) => {
						this.plugin.settings.openInEditMode = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Informational footer ──────────────────────────────────────────────
		const footer = containerEl.createDiv({ cls: "ashlr-md-settings-footer" });
		footer.createEl("p", {
			text: "Ashlr MD must be installed for the URL scheme to work. ",
		});
		const link = footer.createEl("a", {
			text: "Download Ashlr MD →",
			href: "https://md.ashlr.ai",
		});
		link.setAttr("target", "_blank");
		link.setAttr("rel", "noopener");
	}
}
