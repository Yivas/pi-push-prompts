/**
 * The searchable picker's key handling, driven on the real component.
 *
 * No terminal exists here: the list is built with a theme that returns its text
 * unchanged and a keybinding stub, `render` is never called, and every answer is
 * read from the callback Pi receives. Painting the list is `not-run`.
 */

import "../support/pinned-pi-package.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { SearchList } from "../../src/adapter/picker.ts";
import type { PickerItem } from "../../src/core/picker.ts";

/** Colours are dropped: the test reads answers, not a painted frame. */
const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** The keys the component asks about, mapped to the bytes that send them. */
const KEYS: Record<string, string> = {
	"tui.select.confirm": "\r",
	"tui.select.cancel": "\x1b",
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
	"tui.select.pageUp": "\x1b[5~",
	"tui.select.pageDown": "\x1b[6~",
};

const KEYS_STUB = {
	matches: (data: string, action: string) => KEYS[action] === data,
} as unknown as KeybindingsManager;

describe("push-prompts: the searchable picker", () => {
	it("does not finish on Enter when the filter matches nothing", () => {
		const answers: Array<string | undefined> = [];
		const items: PickerItem[] = [
			{ value: "global:alpha", label: "alpha (global)" },
			{ value: "global:beta", label: "beta (global)" },
		];
		const list = new SearchList(
			{ title: "Synthetic list", items },
			PLAIN_THEME,
			KEYS_STUB,
			(value) => answers.push(value),
		);

		list.handleInput("z");
		list.handleInput("\r");
		assert.deepEqual(answers, [], "Enter on an empty list finishes nothing");

		list.handleInput("\x7f");
		list.handleInput("\r");
		assert.deepEqual(
			answers,
			["global:alpha"],
			"after Backspace the list matches again and Enter returns a row",
		);
	});

	it("dismisses the picker on Esc", () => {
		const answers: Array<string | undefined> = [];
		const list = new SearchList(
			{
				title: "Synthetic list",
				items: [{ value: "global:alpha", label: "alpha (global)" }],
			},
			PLAIN_THEME,
			KEYS_STUB,
			(value) => answers.push(value),
		);

		list.handleInput("\x1b");
		assert.deepEqual(answers, [undefined], "Esc is still a cancel");
	});
});
