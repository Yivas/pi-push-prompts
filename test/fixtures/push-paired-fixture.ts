import type { ExtensionAPI, ExtensionFactory, InputSource, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { EXTENSION_SEND_COMMAND, EXTENSION_SEND_TEXT, type FinalizedProfile, messageText, type TimelineEntry } from "./push-finalized-fixture.ts";

/**
 * Input-source pairing fixture. Test double only: not production and not a
 * compatibility claim.
 *
 * The pairing implemented here, exactly this and nothing more:
 * - `input` writes the raw text and source of the event into one latest slot. It overwrites; it is not a queue.
 * - `before_agent_start` (emitted after the auth check) moves the slot into the current run and clears it.
 * - The first USER `message_end` of the run consumes the run snapshot. System and assistant events never do.
 * - A snapshot whose source is "extension" is skipped. The source comes only from the captured `input` event,
 *   never from the message role or text.
 * - Unsupported content (images, several blocks) passes through unchanged, without consuming a replacement.
 *
 * Not used: FIFO, body matching, timestamps, identity of raw text, or markers in model text. The metadata
 * (raw original, expanded original, effective text, snapshot source) is stored in a custom entry, outside the
 * model context. Historical context is never rewritten.
 */

export const PAIRED_ENTRY_TYPE = "push-fixture.paired";

/** Marker stored only in the custom entry. It must never reach the serialized provider request. */
export const PAIRED_METADATA_MARKER = "push-fixture-paired-metadata-only-marker";

export interface PairedEntryData {
	readonly rawOriginal: string;
	readonly expandedOriginal: string;
	readonly effective: string;
	readonly snapshot: { readonly source: InputSource };
	readonly variant: "input-pairing";
	readonly metadataMarker: string;
}

export interface PairedFixtureOptions {
	/** Test-owned gate awaited inside `input` after the slot is written. Undefined means no gate. */
	readonly inputGate?: (rawText: string) => Promise<void> | undefined;
}

interface Snapshot {
	readonly rawOriginal: string;
	readonly source: InputSource;
}

export function createPushPairedFixture(
	profile: FinalizedProfile,
	timeline: TimelineEntry[],
	options: PairedFixtureOptions = {},
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let pending: Snapshot | undefined;
		let run: { snapshot: Snapshot | undefined; consumed: boolean } | undefined;

		pi.on("input", async (event) => {
			pending = { rawOriginal: event.text, source: event.source };
			timeline.push({ stage: "input", text: event.text, source: event.source });
			await options.inputGate?.(event.text);
			return { action: "continue" };
		});

		pi.on("before_agent_start", () => {
			run = { snapshot: pending, consumed: false };
			pending = undefined;
			timeline.push({ stage: "before_agent_start", text: run.snapshot?.rawOriginal, source: run.snapshot?.source });
			return undefined;
		});

		pi.on("message_end", (event: MessageEndEvent) => {
			if (event.message.role !== "user" || !profile.enabled) {
				return undefined;
			}
			const current = run;
			if (!current || current.consumed) {
				timeline.push({ stage: `message_end:skipped:${current ? "already-consumed" : "no-run"}`, role: "user" });
				return undefined;
			}
			current.consumed = true;

			const snapshot = current.snapshot;
			if (!snapshot) {
				timeline.push({ stage: "message_end:skipped:no-snapshot", role: "user" });
				return undefined;
			}
			if (snapshot.source === "extension") {
				timeline.push({ stage: "message_end:skipped:extension-origin", role: "user" });
				return undefined;
			}

			const { content } = event.message;
			const singleText =
				typeof content === "string" || (Array.isArray(content) && content.length === 1 && content[0]?.type === "text");
			if (!singleText) {
				timeline.push({ stage: "message_end:skipped:unsupported-content", role: "user" });
				return undefined;
			}

			const expandedOriginal = messageText(event.message);
			const effective = `${profile.prepend}${expandedOriginal}${profile.append}`;
			const data: PairedEntryData = {
				rawOriginal: snapshot.rawOriginal,
				expandedOriginal,
				effective,
				snapshot: { source: snapshot.source },
				variant: "input-pairing",
				metadataMarker: PAIRED_METADATA_MARKER,
			};
			// Written before Pi persists the finalized message. The custom entry is not part of the model context.
			pi.appendEntry<PairedEntryData>(PAIRED_ENTRY_TYPE, data);
			timeline.push({ stage: "message_end:paired", role: "user", text: expandedOriginal });
			const replacementContent = typeof content === "string" ? effective : [{ type: "text" as const, text: effective }];
			return { message: { ...event.message, content: replacementContent } };
		});

		pi.registerCommand(EXTENSION_SEND_COMMAND, {
			description: "Test-only: sends a synthetic user message through the public extension API",
			handler: async () => {
				pi.sendUserMessage(EXTENSION_SEND_TEXT);
			},
		});
	};
}
