/**
 * Derived from pi-prompt-profiles src/core/refs.ts at 3f6d583 (MIT).
 */

import { isSafeId } from "./ids.ts";
import type { ProfileRef, Scope } from "./types.ts";

export function formatRef(ref: ProfileRef): string {
	return `${ref.scope}:${ref.id}`;
}

/** Parses an explicit `global:id` or `project:id` reference. */
export function parseRef(value: string): ProfileRef | undefined {
	const separator = value.indexOf(":");
	if (separator < 0) {
		return undefined;
	}
	const scope = value.slice(0, separator);
	const id = value.slice(separator + 1);
	if ((scope === "global" || scope === "project") && isSafeId(id)) {
		return { scope, id };
	}
	return undefined;
}

/**
 * Normalizes a reference written by a user.
 *
 * Explicit `scope:id` wins. A bare id is resolved inside `defaultScope`, which
 * keeps stored references stable: a global rule can never start pointing at a
 * project directory that happens to share its name.
 */
export function resolveRef(
	value: string,
	defaultScope: Scope,
): ProfileRef | undefined {
	const trimmed = value.trim();
	const explicit = parseRef(trimmed);
	if (explicit) {
		return explicit;
	}
	if (trimmed.includes(":")) {
		return undefined;
	}
	if (!isSafeId(trimmed)) {
		return undefined;
	}
	return { scope: defaultScope, id: trimmed };
}
