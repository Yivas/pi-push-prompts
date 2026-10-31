import type { ExtensionAPI, ExtensionFactory, MessageEndEvent } from "@earendil-works/pi-coding-agent";

/**
 * Test fixture for the public `message_end` seam. It is not the production plugin.
 *
 * `message_end` runs after Pi has expanded the input (prompt templates, skills) and before the finalized
 * message is persisted. A handler may return a replacement that keeps the message role; Pi then replaces
 * the message object in place and persists the replacement. This fixture uses that only for user
 * messages, without checking where they came from. It never transforms `input`: that handler only
 * observes the raw text and its source.
 *
 * The fixture sees only the finalized message, so the stored `expandedOriginal` is the EXPANDED text, not
 * the raw text the user typed. The `message_end` event carries no origin field; the fields it does carry are
 * recorded in the timeline so a test can show that. This fixture accepts only string content or a
 * single text block; other shapes pass through unchanged rather than losing attachments or blocks.
 */

export const FINALIZED_ENTRY_TYPE = "push-fixture.finalized";

/** Marker stored only in the custom entry. It must never reach the serialized provider request. */
export const FINALIZED_METADATA_MARKER = "push-fixture-finalized-metadata-only-marker";

/** Test-only command that sends a synthetic user message through the public `sendUserMessage` API. */
export const EXTENSION_SEND_COMMAND = "push-fixture-extension-send";
export const EXTENSION_SEND_TEXT = "Synthetic extension message.";

export interface FinalizedProfile {
	enabled: boolean;
	prepend: string;
	append: string;
}

export interface FinalizedEntryData {
	/** The text Pi had when `message_end` fired: expanded, not the raw typed input. */
	readonly expandedOriginal: string;
	readonly effective: string;
	readonly metadataMarker: string;
}

/** Plain-value observation. Never holds a live message or session object. */
export interface TimelineEntry {
	readonly stage: string;
	readonly role?: string;
	readonly text?: string;
	/** Origin reported by the `input` event only; `message_end` has no such field. */
	readonly source?: string;
	/** Sorted top-level keys of the finalized message, as a comma-separated list. */
	readonly fields?: string;
	readonly requestCount?: number;
	readonly persistedUserCount?: number;
}

/** Text of a message's content, read by duck typing so it works for every message role. */
export function messageText(message: object): string {
	if (!("content" in message)) {
		return "";
	}
	const { content } = message;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block: unknown) => {
			if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
				return block.text;
			}
			return "";
		})
		.join("");
}

export interface FinalizedFixtureOptions {
	/**
	 * "preserve" (default) keeps the finalized content shape: an array of text blocks stays an array. "string"
	 * replaces it with a plain string; the text is the same but the serialized historical message differs.
	 */
	replacementShape?: "preserve" | "string";
}

export function createPushFinalizedFixture(
	profile: FinalizedProfile,
	timeline: TimelineEntry[],
	options: FinalizedFixtureOptions = {},
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.on("input", (event) => {
			timeline.push({ stage: "input", text: event.text, source: event.source });
			return { action: "continue" };
		});

		pi.on("message_end", (event: MessageEndEvent) => {
			timeline.push({
				stage: "message_end:extension",
				role: event.message.role,
				text: messageText(event.message),
				fields: Object.keys(event.message).sort().join(","),
			});
			if (!profile.enabled || event.message.role !== "user") {
				return undefined;
			}

			if (
				Array.isArray(event.message.content) &&
				(event.message.content.length !== 1 || event.message.content[0]?.type !== "text")
			) {
				return undefined;
			}

			const expandedOriginal = messageText(event.message);
			const effective = `${profile.prepend}${expandedOriginal}${profile.append}`;
			const data: FinalizedEntryData = { expandedOriginal, effective, metadataMarker: FINALIZED_METADATA_MARKER };
			// Written before Pi persists the finalized message, so the entry precedes its user message.
			pi.appendEntry<FinalizedEntryData>(FINALIZED_ENTRY_TYPE, data);
			const content =
				options.replacementShape === "string" || typeof event.message.content === "string"
					? effective
					: [{ type: "text" as const, text: effective }];
			return { message: { ...event.message, content } };
		});

		pi.registerCommand(EXTENSION_SEND_COMMAND, {
			description: "Test-only: sends a synthetic user message through the public extension API",
			handler: async () => {
				pi.sendUserMessage(EXTENSION_SEND_TEXT);
			},
		});
	};
}
