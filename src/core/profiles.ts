/**
 * Derived from pi-prompt-profiles src/core/profiles.ts at 3f6d583 (MIT).
 *
 * Discovers `profiles/<id>/` directories. A profile holds `prepend.md` and/or
 * `append.md`; both are optional, but at least one of them must hold text.
 * Invalid names, empty profiles, oversized files and symlinks escaping the root
 * are skipped with a diagnostic instead of failing the whole catalog.
 */

import fs from "node:fs";
import path from "node:path";
import { normalizeProfileText } from "./decorate.ts";
import { error, warn } from "./diagnostics.ts";
import { isSafeId } from "./ids.ts";
import {
	isRealPathInside,
	profilesDir,
	readTextIfExists,
	stripBom,
} from "./paths.ts";
import type {
	Diagnostic,
	LoadedProfile,
	ProfileCatalog,
	ProfileMeta,
	Scope,
} from "./types.ts";

export const DEFAULT_MAX_PROFILE_BYTES = 64 * 1024;
export const PREPEND_FILE = "prepend.md";
export const APPEND_FILE = "append.md";

type TextRead = { ok: true; text: string } | { skipProfile: true };

function readProfileText(
	root: string,
	profilePath: string,
	fileName: string,
	profileId: string,
	maxBytes: number,
	diagnostics: Diagnostic[],
): TextRead {
	const filePath = path.join(profilePath, fileName);
	if (!isRealPathInside(root, filePath)) {
		diagnostics.push(
			error(
				"profile-symlink",
				`Profile "${profileId}": ${fileName} resolves outside ${root} and the profile was skipped.`,
			),
		);
		return { skipProfile: true };
	}
	const raw = readTextIfExists(filePath);
	if (raw === undefined) {
		return { ok: true, text: "" };
	}
	if (Buffer.byteLength(raw, "utf8") > maxBytes) {
		diagnostics.push(
			error(
				"profile-too-large",
				`Profile "${profileId}": ${fileName} exceeds ${maxBytes} bytes and the profile was skipped.`,
			),
		);
		return { skipProfile: true };
	}
	return { ok: true, text: stripBom(raw) };
}

export function loadProfiles(
	root: string,
	scope: Scope,
	meta: Record<string, ProfileMeta> | undefined,
	maxBytes: number = DEFAULT_MAX_PROFILE_BYTES,
): ProfileCatalog {
	const directory = profilesDir(root);
	const profiles = new Map<string, LoadedProfile>();
	const diagnostics: Diagnostic[] = [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
			return { scope, profiles, createDiagnostics: [] };
		}
		return {
			scope,
			profiles,
			createDiagnostics: [
				error("profiles-dir", `Could not read ${directory}: ${String(cause)}`),
			],
		};
	}

	const seenCaseInsensitive = new Map<string, string>();

	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) {
			continue;
		}
		const id = entry.name;
		if (!isSafeId(id)) {
			diagnostics.push(
				warn(
					"profile-id",
					`Ignoring ${entry.name}: the directory name is not a safe profile id.`,
				),
			);
			continue;
		}
		const profilePath = path.join(directory, entry.name);
		if (!isRealPathInside(root, profilePath)) {
			diagnostics.push(
				error(
					"profile-symlink",
					`Refusing ${entry.name}: it resolves outside ${root}.`,
				),
			);
			continue;
		}
		const folded = id.toLowerCase();
		const previous = seenCaseInsensitive.get(folded);
		if (previous !== undefined && previous !== id) {
			diagnostics.push(
				warn(
					"profile-case",
					`Profiles "${previous}" and "${id}" collide on case-insensitive filesystems.`,
				),
			);
		}
		seenCaseInsensitive.set(folded, id);

		const prepend = readProfileText(
			root,
			profilePath,
			PREPEND_FILE,
			id,
			maxBytes,
			diagnostics,
		);
		if ("skipProfile" in prepend) {
			continue;
		}
		const append = readProfileText(
			root,
			profilePath,
			APPEND_FILE,
			id,
			maxBytes,
			diagnostics,
		);
		if ("skipProfile" in append) {
			continue;
		}
		if (
			normalizeProfileText(prepend.text) === "" &&
			normalizeProfileText(append.text) === ""
		) {
			diagnostics.push(
				warn(
					"profile-empty",
					`Profile "${id}" has no text in ${PREPEND_FILE} or ${APPEND_FILE} and was skipped.`,
				),
			);
			continue;
		}

		const loaded: LoadedProfile = {
			id,
			scope,
			path: profilePath,
			prepend: prepend.text,
			append: append.text,
		};
		const description = meta?.[id]?.description;
		if (description !== undefined) {
			loaded.description = description;
		}
		profiles.set(id, loaded);
	}

	return { scope, profiles, createDiagnostics: diagnostics };
}
