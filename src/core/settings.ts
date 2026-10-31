/**
 * Derived from pi-prompt-profiles src/core/settings.ts at 3f6d583 (MIT).
 *
 * The scalar keys `/push set` and `/push unset` may touch, plus the effective
 * value of each. Pure: failures come back as a reason, and the command surface
 * turns them into a sentence.
 *
 * `selection` is stored whole, so setting it replaces the object; `manual`
 * needs a profile and has its own command, and `defaultProfile` likewise.
 */

import {
	type ConfigV1,
	DISPLAY_MODES,
	type Scope,
	SELECTION_MODES,
	SUBAGENT_POLICIES,
} from "./types.ts";

/** Scalar configuration keys that `set` and `unset` can change or remove. */
export type SettingKey =
	| "inheritGlobalBindings"
	| "defaultProfile"
	| "display"
	| "selection"
	| "subagents";

export interface SettingSpec {
	key: SettingKey;
	/** Scope where the value may be written. `unset` is allowed in both. */
	setScope: "both" | "project";
	/** `false` when a dedicated command owns the key. */
	settable: boolean;
	/** Accepted values, for the keys that take one. */
	values?: readonly string[];
}

/** `manual` carries a profile, so it is set with `/push use`, not here. */
const SELECTION_SETTING_MODES = SELECTION_MODES.filter(
	(mode) => mode !== "manual",
);

/**
 * A Map, not an object: `__proto__`, `constructor` and `toString` must be
 * unknown settings instead of inherited members.
 */
const SPECS: ReadonlyMap<string, SettingSpec> = new Map([
	[
		"selection",
		{
			key: "selection",
			setScope: "both",
			settable: true,
			values: SELECTION_SETTING_MODES,
		},
	],
	[
		"display",
		{
			key: "display",
			setScope: "both",
			settable: true,
			values: DISPLAY_MODES,
		},
	],
	[
		"subagents",
		{
			key: "subagents",
			setScope: "both",
			settable: true,
			values: SUBAGENT_POLICIES,
		},
	],
	[
		"inheritglobalbindings",
		{
			key: "inheritGlobalBindings",
			setScope: "project",
			settable: true,
		},
	],
	["defaultprofile", { key: "defaultProfile", setScope: "both", settable: false }],
]);

/** `selection.mode` is accepted as a spelling of the whole `selection` object. */
const ALIASES: ReadonlyMap<string, SettingKey> = new Map([
	["selection.mode", "selection"],
]);

/** Why a setting could not be parsed or removed. */
export type SettingProblem =
	| { code: "unknown"; input: string }
	| { code: "own-command"; key: SettingKey }
	| { code: "value"; key: SettingKey; values: readonly string[] }
	| { code: "boolean"; key: SettingKey }
	| { code: "not-set"; key: SettingKey };

export function settingSpec(input: string): SettingSpec | undefined {
	const normalized = input.trim().toLowerCase();
	return SPECS.get(ALIASES.get(normalized) ?? normalized);
}

export function settingKeys(): SettingKey[] {
	return [...SPECS.values()].map((spec) => spec.key);
}

export type ParseResult =
	| { ok: true; spec: SettingSpec; value: string | boolean }
	| { ok: false; problem: SettingProblem };

/** Parses a key and its raw value without touching the file. */
export function parseSetting(input: string, value: string): ParseResult {
	const spec = settingSpec(input);
	if (!spec) {
		return { ok: false, problem: { code: "unknown", input: input.trim() } };
	}
	if (!spec.settable) {
		return { ok: false, problem: { code: "own-command", key: spec.key } };
	}
	const trimmed = value.trim();
	if (spec.key === "inheritGlobalBindings") {
		if (trimmed === "true" || trimmed === "false") {
			return { ok: true, spec, value: trimmed === "true" };
		}
		return { ok: false, problem: { code: "boolean", key: spec.key } };
	}
	const values = spec.values ?? [];
	if (!values.includes(trimmed)) {
		return {
			ok: false,
			problem: { code: "value", key: spec.key, values },
		};
	}
	return { ok: true, spec, value: trimmed };
}

/** `true` when the key is only meaningful in the project config. */
export function isProjectOnly(spec: SettingSpec, scope: Scope): boolean {
	return spec.setScope === "project" && scope === "global";
}

/** Mutates a raw config object; `selection` is always replaced whole. */
export function applySetting(
	config: Record<string, unknown>,
	spec: SettingSpec,
	value: string | boolean,
): void {
	switch (spec.key) {
		case "subagents":
			config.subagents = value;
			return;
		case "inheritGlobalBindings":
			config.inheritGlobalBindings = value;
			return;
		case "display":
			config.display = value;
			return;
		case "selection":
			config.selection = { mode: value };
			return;
		default:
			return;
	}
}

/** Removes a key from a raw config object, preserving everything else. */
export function unsetSetting(
	config: Record<string, unknown>,
	input: string,
): { ok: true; key: SettingKey } | { ok: false; problem: SettingProblem } {
	const spec = settingSpec(input);
	if (!spec) {
		return { ok: false, problem: { code: "unknown", input: input.trim() } };
	}
	if (!Object.hasOwn(config, spec.key)) {
		return { ok: false, problem: { code: "not-set", key: spec.key } };
	}
	delete config[spec.key];
	return { ok: true, key: spec.key };
}

/** Raw value of a key when present and well formed; otherwise `undefined`. */
export function readSettingValue(
	config: ConfigV1 | undefined,
	key: SettingKey,
): string | boolean | undefined {
	if (!config || !Object.hasOwn(config, key)) {
		return undefined;
	}
	switch (key) {
		case "subagents":
			return config.subagents;
		case "inheritGlobalBindings":
			return config.inheritGlobalBindings;
		case "display":
			return config.display;
		case "selection":
			return config.selection?.mode;
		case "defaultProfile":
			return config.defaultProfile;
	}
}

export function defaultSetting(key: SettingKey): string | boolean | undefined {
	switch (key) {
		case "subagents":
			return "bindings";
		case "inheritGlobalBindings":
			return true;
		case "display":
			return "hidden";
		case "selection":
			return "auto";
		case "defaultProfile":
			return undefined;
	}
}

export interface SettingScopes {
	global: ConfigV1 | undefined;
	project: ConfigV1 | undefined;
	projectActive: boolean;
}

export interface EffectiveSetting {
	value: string | boolean | undefined;
	origin: "project" | "global" | "default";
}

/** Project over global over default, with the origin the value came from. */
export function effectiveSetting(
	scopes: SettingScopes,
	key: SettingKey,
): EffectiveSetting {
	if (
		scopes.projectActive &&
		scopes.project &&
		Object.hasOwn(scopes.project, key)
	) {
		const value = readSettingValue(scopes.project, key);
		if (value !== undefined) {
			return { value, origin: "project" };
		}
	}
	if (scopes.global && Object.hasOwn(scopes.global, key)) {
		const value = readSettingValue(scopes.global, key);
		if (value !== undefined) {
			return { value, origin: "global" };
		}
	}
	return { value: defaultSetting(key), origin: "default" };
}
