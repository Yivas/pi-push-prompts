/**
 * Session-branch state for the Pi adapter: the profile chosen for this session
 * and the profile armed for the next finalized user message (`once`).
 *
 * Both live in `push-prompts.state` entries on the active branch, so Pi's own
 * branch, fork and reopen semantics decide what applies. Custom entries never
 * enter the model context.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRef } from "../core/refs.ts";
import type { Selection } from "../core/types.ts";

export const STATE_ENTRY_TYPE = "push-prompts.state";
export const STATE_SCHEMA = 1;

export type ReadonlySession = ExtensionContext["sessionManager"];

export interface PersistedState {
	schema: number;
	/** Session-only override; absent means the config selection applies. */
	selection?: Selection;
	/** Normalized `scope:id` reference armed for the next finalized message. */
	once?: string;
}

export interface BranchState {
	selection?: Selection;
	once?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSelection(value: unknown): Selection | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.mode === "auto" || value.mode === "off") {
		return { mode: value.mode };
	}
	if (value.mode === "manual" && typeof value.profile === "string") {
		const ref = resolveRef(value.profile, "global");
		// A stored reference is normalized, so it always carries its scope. A
		// bare id here means the entry was written by hand or by an older build;
		// resolving it as global would silently pick a different profile.
		if (!ref || !value.profile.includes(":")) {
			return undefined;
		}
		return { mode: "manual", profile: `${ref.scope}:${ref.id}` };
	}
	return undefined;
}

export function parseState(data: unknown): BranchState | undefined {
	if (!isRecord(data) || data.schema !== STATE_SCHEMA) {
		return undefined;
	}
	const state: BranchState = {};
	const selection = parseSelection(data.selection);
	if (selection) {
		state.selection = selection;
	}
	if (typeof data.once === "string") {
		const ref = resolveRef(data.once, "global");
		if (ref && data.once.includes(":")) {
			state.once = `${ref.scope}:${ref.id}`;
		}
	}
	return state;
}

/**
 * Reads the newest state entry on the active branch. The newest entry is
 * authoritative: when it cannot be parsed the session falls back to the config
 * baseline instead of resurrecting an older selection or a stale `once`.
 */
export function readBranchState(sessionManager: ReadonlySession): BranchState {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			entry &&
			entry.type === "custom" &&
			entry.customType === STATE_ENTRY_TYPE
		) {
			return parseState(entry.data) ?? {};
		}
	}
	return {};
}

export function buildStateEntry(
	selection: Selection | undefined,
	once: string | undefined,
): PersistedState {
	const data: PersistedState = { schema: STATE_SCHEMA };
	if (selection) {
		data.selection = selection;
	}
	if (once !== undefined) {
		data.once = once;
	}
	return data;
}
