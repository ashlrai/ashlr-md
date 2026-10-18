import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildUrl,
	EDIT_MODE_SETTING_DESC,
	isOpenableInAshlr,
	OPEN_EDIT_COMMAND_NAME,
	openUrl,
} from "./links.ts";

describe("isOpenableInAshlr", () => {
	it("takes Markdown notes and refuses dotfiles and other files", () => {
		assert.equal(isOpenableInAshlr({ extension: "MD", name: "a.MD" }), true);
		assert.equal(isOpenableInAshlr({ extension: "mdx", name: "a.mdx" }), true);
		assert.equal(isOpenableInAshlr({ extension: "md", name: ".notes.md" }), false);
		assert.equal(isOpenableInAshlr({ extension: "canvas", name: "a.canvas" }), false);
	});
});

describe("buildUrl", () => {
	it("encodes the path and adds the mode when given", () => {
		assert.equal(buildUrl("/My Vault/a&b.md"), "mdopener://open?path=%2FMy%20Vault%2Fa%26b.md");
		assert.equal(buildUrl("/a.md", "edit"), "mdopener://open?path=%2Fa.md&mode=edit");
	});
});

describe("EDIT_MODE_SETTING_DESC", () => {
	// It pointed at an "Open in edit mode" command the palette does not list.
	it("names the edit-mode command as the palette lists it", () => {
		assert.ok(EDIT_MODE_SETTING_DESC.includes(`"${OPEN_EDIT_COMMAND_NAME}"`), EDIT_MODE_SETTING_DESC);
		assert.ok(!EDIT_MODE_SETTING_DESC.includes('"Open in edit mode"'), EDIT_MODE_SETTING_DESC);
	});
});

describe("openUrl", () => {
	// A rejected openExternal used to fall through to window.open, which
	// resolved, so the "could not launch the app" notice never showed.
	it("rejects when the shell cannot open the link, without the fallback", async () => {
		const fellBack: string[] = [];
		await assert.rejects(
			openUrl(
				"mdopener://open?path=%2Fa.md",
				() => ({ openExternal: () => Promise.reject(new Error("no app for mdopener://")) }),
				(u) => fellBack.push(u)
			),
			/no app for mdopener/
		);
		assert.deepEqual(fellBack, []);
	});

	it("opens with the shell, and falls back only when there is no shell", async () => {
		const opened: string[] = [];
		const fellBack: string[] = [];
		await openUrl("mdopener://a", () => ({ openExternal: async (u) => void opened.push(u) }), (u) => fellBack.push(u));
		await openUrl(
			"mdopener://b",
			() => {
				throw new Error("Cannot find module 'electron'");
			},
			(u) => fellBack.push(u)
		);
		assert.deepEqual(opened, ["mdopener://a"]);
		assert.deepEqual(fellBack, ["mdopener://b"]);
	});
});
