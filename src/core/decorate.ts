/**
 * Shapes the effective user message: profile text in, same message with
 * prepend and append inserted, or `undefined` when there is nothing to add.
 *
 * Two rules keep this pure and cache-safe:
 * - The user text is never trimmed, normalized or reordered. Only the inserted
 *   text is new; every other block keeps its fields and position.
 * - The inserted strings are reported verbatim, separators included, so the
 *   original can be recovered and checked later without guessing.
 */

import { stripBom } from "./paths.ts";
import type {
	ContentBlock,
	Decoration,
	DecorationPlacement,
	DecorationShape,
	ProfileLayer,
	UserContent,
} from "./types.ts";

const SEPARATOR = "\n\n";

/**
 * Normalizes one profile text file. A leading BOM, CRLF line endings and the
 * single trailing newline of the file are artifacts of the editor, not part of
 * the wording, so they are removed before insertion. Nothing else changes.
 */
export function normalizeProfileText(text: string): string {
	const unified = stripBom(text).replace(/\r\n/g, "\n");
	return unified.endsWith("\n") ? unified.slice(0, -1) : unified;
}

/**
 * Joins one side of the inheritance chain: the root parent first, the most
 * specific profile last, separated by a blank line. Layers are given specific
 * first, as `ResolvedProfile.layers` holds them.
 */
function joinLayers(
	layers: readonly ProfileLayer[],
	side: "prepend" | "append",
): string {
	const texts = layers
		.map((layer) => normalizeProfileText(layer[side]))
		.filter((text) => text !== "");
	return texts.reverse().join(SEPARATOR);
}

/**
 * The exact strings a profile inserts around a message, separators included.
 * `decorate` builds a message from them and `/push preview` prints them, so the
 * preview cannot drift from what a send would add.
 */
export function insertionOf(layers: readonly ProfileLayer[]): {
	before: string;
	after: string;
} {
	return insertion(joinLayers(layers, "prepend"), joinLayers(layers, "append"));
}

function insertion(
	prefixText: string,
	suffixText: string,
): { before: string; after: string } {
	return {
		before: prefixText === "" ? "" : `${prefixText}${SEPARATOR}`,
		after: suffixText === "" ? "" : `${SEPARATOR}${suffixText}`,
	};
}

function isTextBlock(block: ContentBlock): boolean {
	return block.type === "text" && typeof block.text === "string";
}

function shapeOf(
	content: "string" | "array",
	prefix: DecorationPlacement | undefined,
	suffix: DecorationPlacement | undefined,
): DecorationShape {
	const shape: DecorationShape = { content };
	if (prefix !== undefined) {
		shape.prefix = prefix;
	}
	if (suffix !== undefined) {
		shape.suffix = suffix;
	}
	return shape;
}

/**
 * Inserts the prepend at the start of the array and the append at the end.
 *
 * With a text block at that end the text is merged into it; otherwise a new
 * text block is added on that side. Images and other blocks are neither
 * rewritten nor moved, and the input array is not mutated.
 */
function decorateBlocks(
	blocks: readonly ContentBlock[],
	prefixText: string,
	suffixText: string,
): Decoration {
	const { before, after } = insertion(prefixText, suffixText);
	const first = blocks[0];
	const last = blocks[blocks.length - 1];
	const prefix: DecorationPlacement | undefined = prefixText
		? first !== undefined && isTextBlock(first)
			? "merged"
			: "new-block"
		: undefined;
	const suffix: DecorationPlacement | undefined = suffixText
		? last !== undefined && isTextBlock(last)
			? "merged"
			: "new-block"
		: undefined;

	const decorated = blocks.map((block, index) => {
		if (!isTextBlock(block)) {
			return block;
		}
		let text = block.text as string;
		if (index === 0 && prefix === "merged") {
			text = `${prefixText}${SEPARATOR}${text}`;
		}
		if (index === blocks.length - 1 && suffix === "merged") {
			text = `${text}${SEPARATOR}${suffixText}`;
		}
		return text === block.text ? block : { ...block, text };
	});
	if (prefix === "new-block") {
		decorated.unshift({ type: "text", text: `${prefixText}${SEPARATOR}` });
	}
	if (suffix === "new-block") {
		decorated.push({ type: "text", text: `${SEPARATOR}${suffixText}` });
	}

	return {
		content: decorated,
		insertedPrefix: before,
		insertedSuffix: after,
		shape: shapeOf("array", prefix, suffix),
	};
}

/**
 * Applies the resolved profile to a new user message. Returns `undefined` when
 * no side holds text, which is the only case where the message stays as is.
 */
export function decorate(
	content: UserContent,
	layers: readonly ProfileLayer[],
): Decoration | undefined {
	const prefixText = joinLayers(layers, "prepend");
	const suffixText = joinLayers(layers, "append");
	if (prefixText === "" && suffixText === "") {
		return undefined;
	}
	const { before, after } = insertion(prefixText, suffixText);

	if (typeof content === "string") {
		const prefixed =
			prefixText === "" ? content : `${prefixText}${SEPARATOR}${content}`;
		return {
			content:
				suffixText === "" ? prefixed : `${prefixed}${SEPARATOR}${suffixText}`,
			insertedPrefix: before,
			insertedSuffix: after,
			shape: shapeOf("string", undefined, undefined),
		};
	}

	return decorateBlocks(content, prefixText, suffixText);
}
