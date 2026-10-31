import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionFactory, MessageEndEvent } from "@earendil-works/pi-coding-agent";

/**
 * Test fixture for the public `message_end` seam. It is not production code: the profile is fixed
 * synthetic text, and only the parts these tests exercise are implemented.
 *
 * Pi emits `message_end` for every finalized message after input expansion and before the message is
 * persisted or sent. Returning a same-role replacement makes Pi copy the replacement's fields onto the
 * finalized message object in place, so agent state, later listeners, and the persisted entry stay in
 * sync. The fixture records what it inserted in a custom entry (outside model context) and keeps a
 * WeakSet of message objects it already decorated, so a second emission for the same object is skipped.
 *
 * Content shape, as specified by the design:
 * - string content: inserted prefix/suffix carry the `"\n\n"` separator.
 * - array content: the prefix joins the first block when it is text, otherwise a text block is inserted
 *   before it. The suffix does the same with the last block. Image and other blocks keep their order
 *   and identity.
 *
 * `createOtherDecoratorFixture` stands in for a second extension that also replaces user messages and
 * appends entries in the same event. Tests load it in both orders.
 */

export const FIXTURE_PREPEND = "SYNTHETIC-PREPEND";
export const FIXTURE_APPEND = "SYNTHETIC-APPEND";
export const OTHER_PREPEND = "OTHER-PREPEND";
export const OTHER_APPEND = "OTHER-APPEND";
export const FIXTURE_ENTRY_TYPE = "push-prompts.applied";
export const OTHER_ENTRY_TYPE = "push-fixture.other-applied";

/** Test-only commands that send user messages through the public extension API. */
export const SEND_STEER_COMMAND = "push-contract-send-steer";
export const SEND_FOLLOW_UP_COMMAND = "push-contract-send-follow-up";
export const SEND_IDLE_COMMAND = "push-contract-send-idle";
export const SENT_STEER_TEXT = "Synthetic extension steer message.";
export const SENT_FOLLOW_UP_TEXT = "Synthetic extension follow-up message.";
export const SENT_IDLE_TEXT = "Synthetic extension idle message.";

export type ContentShape = "string" | "existing-text-block" | "inserted-text-block";

export interface AppliedEntryData {
	readonly schemaVersion: 1;
	/** Inserted at the start, including its separator when the text joined a block or the string content. */
	readonly prefix: string;
	/** Inserted at the end, including its separator when the text joined a block or the string content. */
	readonly suffix: string;
	readonly shape: { readonly prepend: ContentShape; readonly append: ContentShape };
	readonly timestamp: number;
	readonly role: "user";
	readonly originalDigest: string;
	readonly effectiveDigest: string;
}

export interface OtherAppliedEntryData {
	readonly prefix: string;
	readonly suffix: string;
	readonly effectiveDigest: string;
}

interface TextBlock {
	readonly type: "text";
	readonly text: string;
}

interface ImageBlock {
	readonly type: "image";
	readonly mimeType: string;
	readonly data: string;
}

type AnyBlock = TextBlock | ImageBlock | { readonly type: string };

interface DecoratedContent {
	readonly content: string | readonly AnyBlock[];
	readonly prefix: string;
	readonly suffix: string;
	readonly shape: { readonly prepend: ContentShape; readonly append: ContentShape };
}

function isTextBlock(block: AnyBlock | undefined): block is TextBlock {
	return block?.type === "text" && typeof (block as TextBlock).text === "string";
}

function isImageBlock(block: AnyBlock | undefined): block is ImageBlock {
	return (
		block?.type === "image" &&
		typeof (block as ImageBlock).mimeType === "string" &&
		typeof (block as ImageBlock).data === "string"
	);
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical array form for digests: text blocks keep their exact text and images are reduced to their
 * MIME type and data digest, so a large attachment does not need to be duplicated in the entry.
 */
function canonicalContent(content: string | readonly AnyBlock[]): string {
	if (typeof content === "string") {
		return content;
	}
	return JSON.stringify(
		content.map((block) => {
			if (isTextBlock(block)) {
				return { type: "text", text: block.text };
			}
			if (isImageBlock(block)) {
				return { type: "image", mimeType: block.mimeType, digest: sha256(block.data) };
			}
			return block;
		}),
	);
}

export function contentDigest(content: string | readonly AnyBlock[]): string {
	return sha256(canonicalContent(content));
}

function joinedPrefix(prepend: string): string {
	return prepend === "" ? "" : `${prepend}\n\n`;
}

function joinedSuffix(append: string): string {
	return append === "" ? "" : `\n\n${append}`;
}

/** Applies the native-shape rules; returns undefined only for content shapes Pi does not produce. */
export function decorateContent(
	content: string | readonly AnyBlock[],
	text: { readonly prepend: string; readonly append: string },
): DecoratedContent | undefined {
	if (typeof content === "string") {
		const prefix = joinedPrefix(text.prepend);
		const suffix = joinedSuffix(text.append);
		return {
			content: `${prefix}${content}${suffix}`,
			prefix,
			suffix,
			shape: { prepend: "string", append: "string" },
		};
	}
	if (!Array.isArray(content)) {
		return undefined;
	}

	const blocks: AnyBlock[] = [...content];
	const first = blocks[0];
	const prefix = joinedPrefix(text.prepend);
	const suffix = joinedSuffix(text.append);
	let prependShape: ContentShape;
	let appendShape: ContentShape;

	if (text.prepend !== "") {
		if (isTextBlock(first)) {
			blocks[0] = { type: "text", text: `${prefix}${first.text}` };
			prependShape = "existing-text-block";
		} else {
			blocks.unshift({ type: "text", text: text.prepend });
			prependShape = "inserted-text-block";
		}
	} else {
		prependShape = "string";
	}

	if (text.append !== "") {
		const lastIndex = blocks.length - 1;
		const lastAfterPrepend = blocks[lastIndex];
		if (isTextBlock(lastAfterPrepend)) {
			blocks[lastIndex] = { type: "text", text: `${lastAfterPrepend.text}${suffix}` };
			appendShape = "existing-text-block";
		} else {
			blocks.push({ type: "text", text: text.append });
			appendShape = "inserted-text-block";
		}
	} else {
		appendShape = "string";
	}

	const insertedPrefix = prependShape === "inserted-text-block" ? text.prepend : prefix;
	const insertedSuffix = appendShape === "inserted-text-block" ? text.append : suffix;
	return {
		content: blocks,
		prefix: insertedPrefix,
		suffix: insertedSuffix,
		shape: { prepend: prependShape, append: appendShape },
	};
}

export interface ContractFixtureOptions {
	readonly prepend?: string;
	readonly append?: string;
	/** Records one plain observation per user message_end, in addition to the entry. */
	readonly onUserMessage?: (message: { readonly timestamp: number }) => void;
}

export function createPushContractFixture(options: ContractFixtureOptions = {}): ExtensionFactory {
	const prepend = options.prepend ?? FIXTURE_PREPEND;
	const append = options.append ?? FIXTURE_APPEND;
	return (pi: ExtensionAPI) => {
		const decorated = new WeakSet<object>();

		pi.on("message_end", (event: MessageEndEvent) => {
			if (event.message.role !== "user" || decorated.has(event.message)) {
				return undefined;
			}
			const content = event.message.content as string | readonly AnyBlock[];
			const result = decorateContent(content, { prepend, append });
			if (!result) {
				return undefined;
			}

			decorated.add(event.message);
			options.onUserMessage?.({ timestamp: event.message.timestamp });
			const data: AppliedEntryData = {
				schemaVersion: 1,
				prefix: result.prefix,
				suffix: result.suffix,
				shape: result.shape,
				timestamp: event.message.timestamp,
				role: "user",
				originalDigest: contentDigest(content),
				effectiveDigest: contentDigest(result.content),
			};
			pi.appendEntry<AppliedEntryData>(FIXTURE_ENTRY_TYPE, data);
			return { message: { ...event.message, content: result.content } as typeof event.message };
		});

		pi.registerCommand(SEND_STEER_COMMAND, {
			description: "Test-only: sends a synthetic user message with deliverAs steer",
			handler: async () => {
				pi.sendUserMessage(SENT_STEER_TEXT, { deliverAs: "steer" });
			},
		});
		pi.registerCommand(SEND_FOLLOW_UP_COMMAND, {
			description: "Test-only: sends a synthetic user message with deliverAs followUp",
			handler: async () => {
				pi.sendUserMessage(SENT_FOLLOW_UP_TEXT, { deliverAs: "followUp" });
			},
		});
		pi.registerCommand(SEND_IDLE_COMMAND, {
			description: "Test-only: sends a synthetic user message while idle",
			handler: async () => {
				pi.sendUserMessage(SENT_IDLE_TEXT);
			},
		});
	};
}

/** Second extension in the same `message_end` event: replaces the user content and appends its own entry. */
export function createOtherDecoratorFixture(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const decorated = new WeakSet<object>();

		pi.on("message_end", (event: MessageEndEvent) => {
			if (event.message.role !== "user" || decorated.has(event.message)) {
				return undefined;
			}
			const content = event.message.content as string | readonly AnyBlock[];
			const result = decorateContent(content, { prepend: OTHER_PREPEND, append: OTHER_APPEND });
			if (!result) {
				return undefined;
			}

			decorated.add(event.message);
			const data: OtherAppliedEntryData = {
				prefix: result.prefix,
				suffix: result.suffix,
				effectiveDigest: contentDigest(result.content),
			};
			pi.appendEntry<OtherAppliedEntryData>(OTHER_ENTRY_TYPE, data);
			return { message: { ...event.message, content: result.content } as typeof event.message };
		});
	};
}
