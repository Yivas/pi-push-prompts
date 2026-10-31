import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Test fixture for the input-decoration seam. It is not the production plugin: it models the
 * contract under test with literal synthetic text so the harness can observe the public boundaries.
 *
 * The `input` event runs before skill and template expansion and before the user message is built.
 * The fixture returns one transformed text, so prepend and append end up inside the same user
 * message. It also stores the original and effective text as a custom entry, which Pi keeps out of
 * the model context. Entry renderers are consulted only by the interactive transcript; the harness
 * resolves the registered renderer through the public extension runner and does not claim a native
 * TUI check.
 */

export const DECORATION_ENTRY_TYPE = "push-fixture.decoration";

/** Marker stored only in the custom entry. It must never reach the serialized provider request. */
export const METADATA_ONLY_MARKER = "push-fixture-metadata-only-marker";

export interface FixtureProfile {
	enabled: boolean;
	prepend: string;
	append: string;
}

export interface DecorationEntryData {
	readonly original: string;
	readonly effective: string;
	readonly metadataMarker: string;
}

export function createPushInputFixture(profile: FixtureProfile): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.on("input", (event) => {
			if (!profile.enabled || event.source === "extension") {
				return { action: "continue" };
			}

			const effective = `${profile.prepend}${event.text}${profile.append}`;
			const data: DecorationEntryData = {
				original: event.text,
				effective,
				metadataMarker: METADATA_ONLY_MARKER,
			};
			pi.appendEntry<DecorationEntryData>(DECORATION_ENTRY_TYPE, data);
			return { action: "transform", text: effective };
		});

		pi.registerEntryRenderer<DecorationEntryData>(DECORATION_ENTRY_TYPE, (entry) => ({
			render: () => [`original (display only): ${entry.data?.original ?? ""}`],
			invalidate() {},
		}));
	};
}
