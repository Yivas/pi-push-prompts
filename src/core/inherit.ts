/**
 * Derived from pi-prompt-profiles src/core/inherit.ts at 3f6d583 (MIT).
 */

import { error } from "./diagnostics.ts";
import { formatRef, resolveRef } from "./refs.ts";
import type {
	Diagnostic,
	LoadedProfile,
	ProfileLayer,
	ProfileMeta,
	ProfileRef,
	ResolvedProfile,
} from "./types.ts";

export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024;

export interface InheritDeps {
	getProfile(ref: ProfileRef): LoadedProfile | undefined;
	getMeta(ref: ProfileRef): ProfileMeta | undefined;
}

export interface InheritOptions {
	maxDepth?: number;
	maxTotalBytes?: number;
}

/**
 * Walks the single optional `extends` chain and returns layers ordered from
 * the most specific profile to its bases. Missing parents, cycles and size or
 * depth limits invalidate the whole profile instead of silently dropping a
 * layer.
 */
export function expandProfile(
	ref: ProfileRef,
	deps: InheritDeps,
	options: InheritOptions = {},
): { profile?: ResolvedProfile; diagnostics: Diagnostic[] } {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	const diagnostics: Diagnostic[] = [];
	const layers: ProfileLayer[] = [];
	const visited = new Set<string>();
	let current: ProfileRef | undefined = ref;
	let totalBytes = 0;

	while (current) {
		const key = formatRef(current);
		if (visited.has(key)) {
			diagnostics.push(
				error("profile-cycle", `Inheritance cycle detected at ${key}.`),
			);
			return { diagnostics };
		}
		if (visited.size >= maxDepth) {
			diagnostics.push(
				error(
					"profile-depth",
					`Inheritance depth exceeds ${maxDepth} at ${key}.`,
				),
			);
			return { diagnostics };
		}
		visited.add(key);

		const loaded = deps.getProfile(current);
		if (!loaded) {
			diagnostics.push(
				error("profile-missing", `Profile ${key} was not found.`),
			);
			return { diagnostics };
		}
		totalBytes += Buffer.byteLength(loaded.prepend, "utf8");
		totalBytes += Buffer.byteLength(loaded.append, "utf8");
		if (totalBytes > maxTotalBytes) {
			diagnostics.push(
				error(
					"profile-total-size",
					`Inherited profiles exceed ${maxTotalBytes} bytes.`,
				),
			);
			return { diagnostics };
		}
		layers.push({
			ref: current,
			prepend: loaded.prepend,
			append: loaded.append,
		});

		const meta = deps.getMeta(current);
		if (meta?.extends === undefined) {
			break;
		}
		const parent = resolveRef(meta.extends, current.scope);
		if (!parent) {
			diagnostics.push(
				error(
					"profile-extends",
					`Profile ${key} has an invalid extends reference "${meta.extends}".`,
				),
			);
			return { diagnostics };
		}
		current = parent;
	}

	return { profile: { ref, layers }, diagnostics };
}
