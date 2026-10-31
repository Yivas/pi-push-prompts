import type {
	ConfigV1,
	LoadedProfile,
	ProfileCatalog,
	ProfileLayer,
	ProfileMeta,
	Scope,
	SourceConfig,
} from "../../src/core/types.ts";

/** A profile layer as `ResolvedProfile.layers` holds it: specific first. */
export function layer(
	id: string,
	prepend = "",
	append = "",
	scope: Scope = "global",
): ProfileLayer {
	return { ref: { scope, id }, prepend, append };
}

export function sourceConfig(
	scope: Scope,
	config?: ConfigV1,
	meta?: Record<string, ProfileMeta>,
): SourceConfig {
	const merged: ConfigV1 | undefined = config
		? {
				...config,
				...(meta ? { profiles: { ...(config.profiles ?? {}), ...meta } } : {}),
			}
		: meta
			? { version: 1, profiles: meta }
			: undefined;
	return {
		scope,
		path: `/virtual/${scope}/config.json`,
		exists: merged !== undefined,
		config: merged,
		diagnostics: [],
	};
}

export interface ProfileSpec {
	id: string;
	prepend?: string;
	append?: string;
	description?: string;
}

export function catalog(scope: Scope, profiles: ProfileSpec[]): ProfileCatalog {
	const map = new Map<string, LoadedProfile>();
	for (const profile of profiles) {
		const loaded: LoadedProfile = {
			id: profile.id,
			scope,
			path: `/virtual/${scope}/profiles/${profile.id}`,
			prepend: profile.prepend ?? "",
			append: profile.append ?? "",
		};
		if (profile.description !== undefined) {
			loaded.description = profile.description;
		}
		map.set(profile.id, loaded);
	}
	return { scope, profiles: map, createDiagnostics: [] };
}
