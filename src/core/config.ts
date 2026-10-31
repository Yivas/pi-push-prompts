/**
 * Derived from pi-prompt-profiles src/core/config.ts at 3f6d583 (MIT).
 *
 * Reads and validates `config.json`. Invalid data is reported and never
 * repaired in place: the file keeps its bytes and the core works with what it
 * could validate.
 */

import { error, warn } from "./diagnostics.ts";
import { isSafeId } from "./ids.ts";
import { readTextIfExists, stripBom } from "./paths.ts";
import { resolveRef } from "./refs.ts";
import {
	type Binding,
	type ConfigV1,
	DISPLAY_MODES,
	type Diagnostic,
	type DisplayMode,
	type MatchRule,
	type ProfileMeta,
	type Scope,
	SELECTION_MODES,
	type SelectionConfig,
	type SourceConfig,
	SUBAGENT_POLICIES,
} from "./types.ts";

const CONFIG_VERSION = 1;
const MAX_BINDINGS = 200;
const KNOWN_KEYS = new Set([
	"version",
	"selection",
	"defaultProfile",
	"profiles",
	"bindings",
	"inheritGlobalBindings",
	"subagents",
	"display",
]);

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadConfigFile(filePath: string, scope: Scope): SourceConfig {
	const text = readTextIfExists(filePath);
	if (text === undefined) {
		return {
			scope,
			path: filePath,
			exists: false,
			config: undefined,
			diagnostics: [],
		};
	}

	let raw: unknown;
	try {
		raw = JSON.parse(stripBom(text));
	} catch (cause) {
		return {
			scope,
			path: filePath,
			exists: true,
			config: undefined,
			diagnostics: [
				error(
					"config-parse",
					`${filePath}: invalid JSON (${messageOf(cause)}).`,
				),
			],
		};
	}

	const diagnostics: Diagnostic[] = [];
	const config = validateConfig(raw, scope, filePath, diagnostics);
	return { scope, path: filePath, exists: true, config, diagnostics };
}

function validateConfig(
	raw: unknown,
	scope: Scope,
	filePath: string,
	diagnostics: Diagnostic[],
): ConfigV1 | undefined {
	if (!isRecord(raw)) {
		diagnostics.push(
			error("config-shape", `${filePath}: the root must be an object.`),
		);
		return undefined;
	}
	if (raw.version !== CONFIG_VERSION) {
		diagnostics.push(
			error(
				"config-version",
				`${filePath}: unsupported version ${JSON.stringify(raw.version)}; expected ${CONFIG_VERSION}. The file was not applied.`,
			),
		);
		return undefined;
	}

	const config: ConfigV1 = { version: CONFIG_VERSION };

	const selection = validateSelection(
		raw.selection,
		scope,
		filePath,
		diagnostics,
	);
	if (selection) {
		config.selection = selection;
	}

	if (raw.defaultProfile !== undefined) {
		if (typeof raw.defaultProfile !== "string") {
			diagnostics.push(
				error(
					"config-default",
					`${filePath}: defaultProfile must be a string.`,
				),
			);
		} else if (!resolveRef(raw.defaultProfile, scope)) {
			diagnostics.push(
				error(
					"config-default",
					`${filePath}: defaultProfile "${raw.defaultProfile}" is not a valid reference.`,
				),
			);
		} else {
			config.defaultProfile = raw.defaultProfile;
		}
	}

	if (raw.profiles !== undefined) {
		if (!isRecord(raw.profiles)) {
			diagnostics.push(
				error("config-profiles", `${filePath}: profiles must be an object.`),
			);
		} else {
			const profiles: Record<string, ProfileMeta> = {};
			for (const [id, value] of Object.entries(raw.profiles)) {
				if (!isSafeId(id)) {
					diagnostics.push(
						warn(
							"config-profile-id",
							`${filePath}: profile key "${id}" is not a safe id and was ignored.`,
						),
					);
					continue;
				}
				if (!isRecord(value)) {
					diagnostics.push(
						warn(
							"config-profile-meta",
							`${filePath}: profiles.${id} must be an object and was ignored.`,
						),
					);
					continue;
				}
				const meta: ProfileMeta = {};
				if (value.extends !== undefined) {
					if (
						typeof value.extends !== "string" ||
						!resolveRef(value.extends, scope)
					) {
						diagnostics.push(
							error(
								"config-extends",
								`${filePath}: profiles.${id}.extends "${String(value.extends)}" is not a valid reference.`,
							),
						);
					} else {
						meta.extends = value.extends;
					}
				}
				if (value.description !== undefined) {
					if (typeof value.description !== "string") {
						diagnostics.push(
							warn(
								"config-description",
								`${filePath}: profiles.${id}.description must be a string.`,
							),
						);
					} else {
						meta.description = value.description;
					}
				}
				profiles[id] = meta;
			}
			config.profiles = profiles;
		}
	}

	if (raw.bindings !== undefined) {
		if (!Array.isArray(raw.bindings)) {
			diagnostics.push(
				error("config-bindings", `${filePath}: bindings must be an array.`),
			);
		} else if (raw.bindings.length > MAX_BINDINGS) {
			diagnostics.push(
				error(
					"config-bindings",
					`${filePath}: more than ${MAX_BINDINGS} bindings; the bindings were ignored.`,
				),
			);
		} else {
			const bindings: Binding[] = [];
			for (const value of raw.bindings) {
				const binding = validateBinding(value, scope, filePath, diagnostics);
				if (binding) {
					bindings.push(binding);
				}
			}
			config.bindings = bindings;
		}
	}

	if (raw.inheritGlobalBindings !== undefined) {
		if (typeof raw.inheritGlobalBindings !== "boolean") {
			diagnostics.push(
				warn(
					"config-inherit",
					`${filePath}: inheritGlobalBindings must be a boolean and was ignored.`,
				),
			);
		} else if (scope === "global") {
			diagnostics.push(
				warn(
					"config-inherit",
					`${filePath}: inheritGlobalBindings is only meaningful in the project config.`,
				),
			);
			config.inheritGlobalBindings = raw.inheritGlobalBindings;
		} else {
			config.inheritGlobalBindings = raw.inheritGlobalBindings;
		}
	}

	if (raw.subagents !== undefined) {
		if (
			(SUBAGENT_POLICIES as readonly string[]).includes(raw.subagents as string)
		) {
			config.subagents = raw.subagents as (typeof SUBAGENT_POLICIES)[number];
		} else {
			diagnostics.push(
				warn(
					"config-subagents",
					`${filePath}: subagents must be ${SUBAGENT_POLICIES.map((value) => `"${value}"`).join(", ")} and was ignored.`,
				),
			);
		}
	}

	if (raw.display !== undefined) {
		if ((DISPLAY_MODES as readonly string[]).includes(raw.display as string)) {
			config.display = raw.display as DisplayMode;
		} else {
			diagnostics.push(
				warn(
					"config-display",
					`${filePath}: display must be ${DISPLAY_MODES.map((value) => `"${value}"`).join(" or ")} and was ignored; the added text is not shown.`,
				),
			);
		}
	}

	const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
	if (unknown.length > 0) {
		diagnostics.push(
			warn(
				"config-unknown",
				`${filePath}: unknown keys were preserved but not interpreted: ${unknown.join(", ")}.`,
			),
		);
	}

	return config;
}

function validateSelection(
	raw: unknown,
	scope: Scope,
	filePath: string,
	diagnostics: Diagnostic[],
): SelectionConfig | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!isRecord(raw) || typeof raw.mode !== "string") {
		diagnostics.push(
			error(
				"config-selection",
				`${filePath}: selection must be an object with a mode.`,
			),
		);
		return undefined;
	}
	if (raw.mode === "auto" || raw.mode === "off") {
		return { mode: raw.mode };
	}
	if (raw.mode === "manual") {
		if (typeof raw.profile !== "string" || !resolveRef(raw.profile, scope)) {
			diagnostics.push(
				error(
					"config-selection",
					`${filePath}: selection.profile is not a valid reference.`,
				),
			);
			return undefined;
		}
		return { mode: "manual", profile: raw.profile };
	}
	diagnostics.push(
		error(
			"config-selection",
			`${filePath}: unknown selection mode "${raw.mode}". Known: ${SELECTION_MODES.join(", ")}.`,
		),
	);
	return undefined;
}

function validateBinding(
	raw: unknown,
	scope: Scope,
	filePath: string,
	diagnostics: Diagnostic[],
): Binding | undefined {
	if (!isRecord(raw)) {
		diagnostics.push(
			warn("config-binding", `${filePath}: a binding must be an object.`),
		);
		return undefined;
	}
	const id = raw.id;
	const profile = raw.profile;
	if (typeof id !== "string" || !isSafeId(id)) {
		diagnostics.push(
			warn(
				"config-binding-id",
				`${filePath}: a binding has an invalid id and was ignored.`,
			),
		);
		return undefined;
	}
	if (typeof profile !== "string" || !resolveRef(profile, scope)) {
		diagnostics.push(
			warn(
				"config-binding-profile",
				`${filePath}: binding "${id}" has an invalid profile reference and was ignored.`,
			),
		);
		return undefined;
	}
	if (!Array.isArray(raw.match) || raw.match.length === 0) {
		diagnostics.push(
			warn(
				"config-binding-match",
				`${filePath}: binding "${id}" needs at least one match rule and was ignored.`,
			),
		);
		return undefined;
	}
	const match: MatchRule[] = [];
	for (const rule of raw.match) {
		const parsed = validateRule(rule, filePath, id, diagnostics);
		if (parsed) {
			match.push(parsed);
		}
	}
	if (match.length === 0) {
		return undefined;
	}
	const binding: Binding = { id, profile, match };
	if (raw.priority !== undefined) {
		if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
			diagnostics.push(
				warn(
					"config-binding-priority",
					`${filePath}: binding "${id}" has a non-numeric priority and was ignored.`,
				),
			);
		} else {
			binding.priority = raw.priority;
		}
	}
	return binding;
}

function validateRule(
	raw: unknown,
	filePath: string,
	bindingId: string,
	diagnostics: Diagnostic[],
): MatchRule | undefined {
	if (!isRecord(raw)) {
		diagnostics.push(
			warn(
				"config-binding-match",
				`${filePath}: binding "${bindingId}" has a non-object match rule.`,
			),
		);
		return undefined;
	}
	const rule: MatchRule = {};
	for (const field of ["provider", "model"] as const) {
		const value = raw[field];
		if (value === undefined) {
			continue;
		}
		if (typeof value !== "string" || value.length === 0) {
			// A malformed field must not degrade to a wildcard: keeping the rule
			// without it would make the binding match every model.
			diagnostics.push(
				warn(
					"config-binding-match",
					`${filePath}: binding "${bindingId}" has an invalid ${field}; the whole rule was ignored.`,
				),
			);
			return undefined;
		}
		rule[field] = value;
	}
	return rule;
}
