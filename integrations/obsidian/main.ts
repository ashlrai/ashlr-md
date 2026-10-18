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
import {
	buildUrl,
	EDIT_MODE_SETTING_DESC,
	type ExternalOpener,
	isOpenableInAshlr,
	OPEN_COMMAND_NAME,
	OPEN_EDIT_COMMAND_NAME,
	openUrl,
} from "./links.ts";

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

/** Electron's `shell`, which opens custom URL schemes on every desktop OS. */
function electronShell(): ExternalOpener {
	// Electron is always present in the Obsidian desktop app.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return (require("electron") as { shell: ExternalOpener }).shell;
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
			name: OPEN_COMMAND_NAME,
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !isOpenableInAshlr(file)) return false;
				if (!checking) this.openFile(file);
				return true;
			},
		});

		// Command 2: always open in edit mode, regardless of the setting.
		this.addCommand({
			id: "open-current-edit",
			name: OPEN_EDIT_COMMAND_NAME,
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !isOpenableInAshlr(file)) return false;
				if (!checking) this.openFile(file, "edit");
				return true;
			},
		});

		// ── File-explorer context menu ────────────────────────────────────────
		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(menu: Menu, file: TAbstractFile) => {
					// Only show for files Ashlr MD opens (no folders, PDFs or
					// canvases).
					if (!(file instanceof TFile) || !isOpenableInAshlr(file)) return;

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
				if (!file || !isOpenableInAshlr(file)) return;

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
		if (!isOpenableInAshlr(file)) {
			new Notice(
				"Open in Ashlr MD: Ashlr MD opens only Markdown notes " +
					"(.md, .markdown, .mdown, .mkd, .mdx) that are not dotfiles."
			);
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
		openUrl(url, electronShell, (u) => window.open(u)).catch((err: unknown) => {
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
			.setDesc(EDIT_MODE_SETTING_DESC)
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
