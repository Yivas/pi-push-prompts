/**
 * Derived from pi-prompt-profiles src/adapter/picker.ts at 3f6d583 (MIT).
 *
 * Searchable list for the interactive terminal, and the paged selector used
 * every other mode. Pi's own selector has no filter and renders every option,
 * so a provider or profile catalogue would push the dialog off the screen;
 * this component keeps at most ten rows and filters as the user types.
 */

import type {
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { filterItems, type PickerItem, visibleWindow } from "../core/picker.ts";
import { en } from "../i18n/en.ts";

const MAX_VISIBLE = 10;
const HINT = en.picker.hint;

/** Rows reserved for the title, the search line, the hint and the counter. */
const CHROME_ROWS = 8;

/**
 * How many list rows fit in the terminal. Pi renders the component inline, so a
 * list taller than the screen would scroll the dialog out of view. Below eight
 * rows the title, the search line and the hint no longer fit even with one row.
 */
export function visibleRows(rows: number): number {
	if (!Number.isFinite(rows) || rows <= 0) {
		return 3;
	}
	return Math.max(1, Math.min(MAX_VISIBLE, Math.floor(rows) - CHROME_ROWS));
}

export interface PickerRequest {
	title: string;
	subtitle?: string;
	items: readonly PickerItem[];
}

/**
 * Conservative column count: a tab is three columns, and every code point at
 * or above U+1100 (CJK, Hangul, emoji) is two. Over-estimating only truncates
 * earlier, and Pi aborts rendering when a line is wider than the terminal.
 */
function columnWidth(character: string): number {
	if (character === "\t") {
		return 3;
	}
	return (character.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
}

export function displayWidth(text: string): number {
	let width = 0;
	for (const character of text) {
		width += columnWidth(character);
	}
	return width;
}

/**
 * Cuts one line to the width, ending a clipped line with an ellipsis. The
 * ellipsis is one of the columns, so a rendered line never outgrows the
 * terminal Pi aborts on.
 */
function truncate(text: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	const clipped = displayWidth(text) > width;
	const limit = clipped ? width - 1 : width;
	let result = "";
	let used = 0;
	for (const character of text) {
		const size = columnWidth(character);
		if (used + size > limit) {
			break;
		}
		const code = character.codePointAt(0) ?? 0;
		// A rendered element is one line: control characters that would break
		// that, or inject terminal escapes, become spaces.
		const safe =
			character === "\t" || (code >= 0x20 && code !== 0x7f) ? character : " ";
		result += safe;
		used += size;
	}
	return clipped ? `${result}…` : result;
}

export class SearchList {
	/**
	 * What this dialog offers. It is public so a host or a test can read the
	 * title and the rows without painting the component.
	 */
	readonly request: PickerRequest;
	private query = "";
	private selected = 0;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (value: string | undefined) => void;
	private readonly maxVisible: number;

	constructor(
		request: PickerRequest,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (value: string | undefined) => void,
		maxVisible: number = MAX_VISIBLE,
	) {
		this.request = request;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.maxVisible = maxVisible;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { title, subtitle, items } = this.request;
		const filtered = filterItems(items, this.query);
		const lines: string[] = [
			this.theme.fg("accent", this.theme.bold(truncate(title, width))),
		];
		if (subtitle) {
			lines.push(this.theme.fg("muted", truncate(subtitle, width)));
		}
		const prefix = truncate(en.picker.search, width);
		const searchText = this.query === "" ? en.picker.searchHint : this.query;
		const search = truncate(
			searchText,
			Math.max(0, width - displayWidth(prefix)),
		);
		lines.push(
			`${this.theme.fg("muted", prefix)}${
				this.query === "" ? this.theme.fg("dim", search) : search
			}`,
		);
		lines.push("");
		if (filtered.length === 0) {
			lines.push(this.theme.fg("muted", truncate(en.picker.noMatches, width)));
		} else {
			const { start, end } = visibleWindow(
				filtered.length,
				this.selected,
				this.maxVisible,
			);
			for (let index = start; index < end; index += 1) {
				const item = filtered[index];
				if (!item) {
					continue;
				}
				const isSelected = index === this.selected;
				const line = truncate(
					`${isSelected ? "→ " : "  "}${item.label}`,
					width,
				);
				lines.push(this.theme.fg(isSelected ? "accent" : "text", line));
			}
			if (filtered.length > this.maxVisible) {
				lines.push(
					this.theme.fg(
						"muted",
						truncate(en.picker.counter(start + 1, end, filtered.length), width),
					),
				);
			}
		}
		lines.push("");
		lines.push(this.theme.fg("muted", truncate(HINT, width)));
		return lines;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.move(-this.maxVisible);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.move(this.maxVisible);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			this.done(filterItems(this.request.items, this.query)[this.selected]?.value);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (data === "\x7f" || data === "\b") {
			this.query = this.query.slice(0, -1);
			this.selected = 0;
			return;
		}
		// Printable ASCII only: enough for provider and model ids, and it keeps
		// escape sequences from leaking into the filter.
		if (/^[ -~]$/.test(data)) {
			this.query += data;
			this.selected = 0;
		}
	}

	private move(delta: number): void {
		const total = filterItems(this.request.items, this.query).length;
		if (total === 0) {
			return;
		}
		this.selected = Math.min(Math.max(this.selected + delta, 0), total - 1);
	}
}

/**
 * Asks the user to pick one item. In the terminal it opens the searchable list;
 * in every other mode it falls back to Pi's selector, paged so a long catalogue
 * never fills the screen. Both paths return `undefined` when the user cancels.
 */
export async function selectItem(
	ctx: ExtensionCommandContext,
	request: PickerRequest,
): Promise<string | undefined> {
	if (ctx.mode === "tui") {
		return ctx.ui.custom<string | undefined>(
			(tui, theme, keybindings, done) =>
				new SearchList(
					request,
					theme,
					keybindings,
					done,
					visibleRows(tui.terminal.rows),
				),
		);
	}
	return selectPaged(ctx, request);
}

async function selectPaged(
	ctx: ExtensionCommandContext,
	request: PickerRequest,
): Promise<string | undefined> {
	const { title, items } = request;
	if (items.length <= MAX_VISIBLE) {
		const choice = await ctx.ui.select(
			title,
			items.map((item) => item.label),
		);
		return items.find((item) => item.label === choice)?.value;
	}
	let offset = 0;
	for (;;) {
		const page = items.slice(offset, offset + MAX_VISIBLE);
		const options = page.map((item) => item.label);
		if (offset > 0) {
			options.push(en.picker.previousPage);
		}
		if (offset + MAX_VISIBLE < items.length) {
			options.push(en.picker.more);
		}
		const choice = await ctx.ui.select(title, options);
		if (choice === undefined) {
			return undefined;
		}
		if (choice === en.picker.previousPage) {
			offset = Math.max(0, offset - MAX_VISIBLE);
			continue;
		}
		if (choice === en.picker.more) {
			offset += MAX_VISIBLE;
			continue;
		}
		const index = options.indexOf(choice);
		return index >= 0 ? page[index]?.value : undefined;
	}
}
