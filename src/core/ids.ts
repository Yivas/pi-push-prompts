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
