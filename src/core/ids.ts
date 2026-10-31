/**
 * Derived from pi-prompt-profiles src/core/ids.ts at 3f6d583 (MIT).
 */

export const MAX_ID_LENGTH = 64;

/**
 * Ids are used as directory names, so they must not contain path separators,
 * traversal segments or leading dots.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeId(id: string): boolean {
	return (
		id.length > 0 &&
		id.length <= MAX_ID_LENGTH &&
		ID_PATTERN.test(id) &&
		!id.includes("..")
	);
}

/**
 * The id to offer for a name a person typed, or "" when no id can be derived.
 *
 * The create dialog asks for a name, not an id, so "Pensamiento abstracto" has
 * to become something a directory can be called. NFKD splits an accented letter
 * into its base and a combining mark, and the marks are dropped, so `á` becomes
 * `a` and `ñ` becomes `n`. Whatever an id cannot hold becomes one separator, and
 * leading and trailing separators are removed because an id starts with a
 * letter or digit. A single dot is kept, so `my.profile` survives, but a run of
 * dots collapses: `..` is a traversal segment and never valid.
 */
export function suggestId(name: string): string {
	const folded = name
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/-{2,}/g, "-")
		.replace(/^[._-]+/, "")
		.slice(0, MAX_ID_LENGTH)
		.replace(/[._-]+$/, "");
	return isSafeId(folded) ? folded : "";
}
