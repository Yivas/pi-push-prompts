/**
 * Presentation: the optional Push row that explains what was added to one user
 * message, and the native row that keeps painting the original text.
 *
 * Nothing here may change what is stored or what the provider receives. Both
 * paths read the session and the config while painting, and both return the
 * input unchanged when the data does not prove the answer.
 */

import type {
	EntryRenderer,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	APPLIED_ENTRY_TYPE,
	type DisplayRecord,
	contentDigest,
	createDisplayLookup,
	parseAppliedEntry,
	recoverOriginal,
} from "../core/applied.ts";
import { en } from "../i18n/en.ts";
import type {
	AppliedEntry,
	ContentBlock,
	DisplayMode,
	UserContent,
} from "../core/types.ts";

/**
 * Pi message content in the shape the pure core reads. The core only looks at
 * `type`, `text`, `data` and `mimeType` and copies every other field through,
 * so no block is rebuilt or narrowed on the way in.
 */
export function toUserContent(
	content: string | readonly (ContentBlock | { type: string })[] | UserContent,
): UserContent {
	return content as UserContent;
}

/** One decorated message as the session holds it, original recovered when possible. */
export interface AppliedView {
	entry: AppliedEntry;
	/** Text of the stored user message; Pi paints exactly this in the native row. */
	effective: string;
	/** Original text, or undefined when another writer changed the message. */
	original: string | undefined;
	intact: boolean;
}

/** Text of a user message as Pi paints it: the text blocks concatenated. */
export function messageText(content: UserContent): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block: ContentBlock) =>
			block.type === "text" && typeof block.text === "string" ? block.text : "",
		)
		.join("");
}

/**
 * Pairs every applied entry on the branch with the user message it describes.
 *
 * The entry is appended while the message finalizes, so its message is the
 * next message entry on the branch and must match both the digest of the
 * effective content and the message timestamp. Anything else means the message
 * was never persisted, was changed later by another writer, or the entry was
 * written by hand: it is reported as not intact and never guessed at.
 */
export function collectAppliedViews(
	entries: readonly SessionEntry[],
): AppliedView[] {
	const views: AppliedView[] = [];
	let pending: AppliedEntry | undefined;

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === APPLIED_ENTRY_TYPE) {
			const parsed = parseAppliedEntry(entry.data);
			// A newer entry supersedes an older one that never found its message.
			pending = parsed;
			continue;
		}
		if (entry.type !== "message") {
			continue;
		}
		const candidate = pending;
		pending = undefined;
		const message = entry.message;
		if (!candidate || message.role !== "user") {
			continue;
		}
		const content = toUserContent(message.content);
		const effective = messageText(content);
		const matches =
			contentDigest(content) === candidate.effectiveDigest &&
			message.timestamp === candidate.timestamp;
		if (!matches) {
			views.push({ entry: candidate, effective, original: undefined, intact: false });
			continue;
		}
		const original = recoverOriginal(content, candidate);
		views.push({
			entry: candidate,
			effective,
			original: original === undefined ? undefined : messageText(original),
			intact: original !== undefined,
		});
	}

	return views;
}

/**
 * The last `count` decorated messages, newest last, for `/push show`.
 *
 * A message another writer changed after we decorated it is still listed: the
 * entry exists, the text was inserted, and hiding it would tell the user their
 * send was never decorated. It is reported with `intact: false` and no
 * original, which is what the command shows as "modified after decoration".
 */
export function recentApplied(
	entries: readonly SessionEntry[],
	count: number,
): AppliedView[] {
	const views = collectAppliedViews(entries);
	return count > 0 ? views.slice(-count) : [];
}

/**
 * Native-row transformer: paints the original text of a decorated message.
 *
 * Pi hands the transformer the text of the user row, which for a stored
 * message is the exact text that was persisted. The lookup is rebuilt only
 * when the branch grew, so a reopened session and a live one both resolve, and
 * an ambiguous text (several originals, or a text that is another message's
 * original) is left untouched. Pure and non-throwing by contract: a failure to
 * read the session must never break rendering.
 */
export function createNativeRowTransformer(
	readEntries: () => readonly SessionEntry[],
): (markdown: string) => string {
	let cachedKey = "";
	let lookup: ((markdown: string) => string | undefined) | undefined;

	return (markdown: string): string => {
		try {
			const entries = readEntries();
			const key = `${entries.length}:${entries[entries.length - 1]?.id ?? ""}`;
			if (key !== cachedKey || !lookup) {
				lookup = lookupFor(entries);
				cachedKey = key;
			}
			return lookup(markdown) ?? markdown;
		} catch {
			return markdown;
		}
	};
}

function lookupFor(
	entries: readonly SessionEntry[],
): (markdown: string) => string | undefined {
	const records: DisplayRecord[] = [];
	for (const view of collectAppliedViews(entries)) {
		if (view.intact && view.original !== undefined) {
			records.push({
				entry: view.entry,
				effective: view.effective,
				original: view.original,
			});
		}
	}
	return createDisplayLookup(records);
}

/** Terminal controls are data, never styling or cursor commands from a profile. */
function literalDisplayText(text: string): string {
	return stripTerminalSequences(text).replace(/\p{Cc}/gu, (character) => {
		if (character === "\n") {
			return character;
		}
		return character === "\t"
			? "\\t"
			: `\\u{${character.codePointAt(0)?.toString(16)}}`;
	});
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Scan each grapheme once; only the current row is revisited at a soft break. */
function wrapLiteralLine(line: string, width: number): string[] {
	const lines: string[] = [];
	let row = "";
	let columns = 0;
	let breakAfterSpace = 0;
	for (const { segment } of GRAPHEME_SEGMENTER.segment(line)) {
		const segmentColumns = visibleWidth(segment);
		while (row !== "" && columns + segmentColumns > width) {
			const end = breakAfterSpace || row.length;
			lines.push(row.slice(0, end));
			row = row.slice(end);
			columns = visibleWidth(row);
			breakAfterSpace = 0;
		}
		if (segment === " " && row !== "") {
			breakAfterSpace = row.length + 1;
		}
		row += segment;
		columns += segmentColumns;
	}
	lines.push(row);
	return lines;
}

/**
 * The optional Push row. `hidden` draws nothing at all: Pi skips a renderer
 * that returns undefined, so no empty spacer is left behind.
 */
export function createAppliedEntryRenderer(
	display: () => DisplayMode,
): EntryRenderer<AppliedEntry> {
	return (entry, _options, theme) => {
		const data = parseAppliedEntry(entry.data);
		if (!data || display() !== "added") {
			return undefined;
		}
		return {
			render: (width) => {
				// A one-column viewport cannot display a wide grapheme safely.
				if (width < 2) {
					return [];
				}
				const lines = ["", ...wrapTextWithAnsi(
					en.extension.entryTitle(data.profile, data.mode), width,
				).map((line) => theme.fg("muted", line))];
				const gutter = width >= 6 ? "  │ " : "";
				const bodyWidth = width - visibleWidth(gutter);
				const side = (label: string, text: string): void => {
					lines.push(...wrapTextWithAnsi(label, width).map((line) => theme.fg("muted", line)));
					for (const line of literalDisplayText(text).split("\n")) {
						for (const part of wrapLiteralLine(line, bodyWidth)) {
							lines.push(theme.fg("borderMuted", gutter) + theme.fg("text", part));
						}
					}
				};
				// Only remove the composition's two-newline separator, never profile whitespace.
				if (data.insertedPrefix !== "") {
					side(en.extension.entryBefore, data.insertedPrefix.slice(0, -2));
				}
				if (data.insertedSuffix !== "") {
					side(en.extension.entryAfter, data.insertedSuffix.slice(2));
				}
				lines.push("");
				return lines;
			},
			invalidate: () => {},
		};
	};
}
