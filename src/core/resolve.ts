/**
 * Derived from pi-prompt-profiles src/core/resolve.ts at 3f6d583 (MIT).
 *
 * Pure, deterministic resolution of the profile that applies to a new user
 * message. Selection wins over project bindings (only with trust), then global
 * bindings, then the project default, then the global default, then nothing.
 */

import { error, info, warn } from "./diagnostics.ts";
import { expandProfile, type InheritDeps } from "./inherit.ts";
import { matchBinding } from "./match.ts";
import { formatRef, resolveRef } from "./refs.ts";
import type {
	BindingMatch,
	ConfigV1,
	Diagnostic,
	ModelIdentity,
	ProfileCatalog,
	ProfileMeta,
	ProfileRef,
	Resolution,
	Scope,
	Selection,
	SourceConfig,
} from "./types.ts";

export interface ResolveSources {
	global: SourceConfig;
	project?: SourceConfig;
	globalProfiles: ProfileCatalog;
	projectProfiles?: ProfileCatalog;
	projectTrusted: boolean;
}

export interface ResolveOptions {
	/** Skip `defaultProfile`: only an explicit binding can match. */
	bindingsOnly?: boolean;
}

export function isProjectActive(sources: ResolveSources): boolean {
	return sources.projectTrusted && sources.project?.config !== undefined;
}

export function createInheritDeps(sources: ResolveSources): InheritDeps {
	return {
		getProfile(ref: ProfileRef) {
			if (ref.scope === "project") {
				return isProjectActive(sources)
					? sources.projectProfiles?.profiles.get(ref.id)
					: undefined;
			}
			return sources.globalProfiles.profiles.get(ref.id);
		},
		getMeta(ref: ProfileRef): ProfileMeta | undefined {
			if (ref.scope === "project") {
				return isProjectActive(sources)
					? sources.project?.config?.profiles?.[ref.id]
					: undefined;
			}
			return sources.global.config?.profiles?.[ref.id];
		},
	};
}

export interface ChooseBindingResult {
	winner?: BindingMatch;
	ignored: BindingMatch[];
	conflict: boolean;
}

function normalizedProfile(bindingProfile: string, scope: Scope): string {
	const ref = resolveRef(bindingProfile, scope);
	return ref ? formatRef(ref) : `invalid:${bindingProfile}`;
}

/**
 * Picks the winning binding inside one scope: highest priority first, then the
 * most specific matching rule. A remaining tie between different profiles is
 * reported as a conflict instead of being broken by filesystem order.
 */
export function chooseBinding(
	bindings: BindingMatch[],
	scope: Scope,
): ChooseBindingResult {
	if (bindings.length === 0) {
		return { ignored: [], conflict: false };
	}
	const maxPriority = Math.max(
		...bindings.map((match) => match.binding.priority ?? 0),
	);
	const byPriority = bindings.filter(
		(match) => (match.binding.priority ?? 0) === maxPriority,
	);
	const maxSpecificity = Math.max(
		...byPriority.map((match) => match.specificity),
	);
	const top = byPriority.filter(
		(match) => match.specificity === maxSpecificity,
	);
	const distinctProfiles = new Set(
		top.map((match) => normalizedProfile(match.binding.profile, scope)),
	);
	if (distinctProfiles.size > 1) {
		return { ignored: bindings, conflict: true };
	}
	const winner = top[0];
	const ignored = bindings.filter((match) => match !== winner);
	return winner
		? { winner, ignored, conflict: false }
		: { ignored, conflict: false };
}

/** Matching bindings for a model, in scope order (project first). */
export function collectBindings(
	sources: ResolveSources,
	model: ModelIdentity,
): BindingMatch[] {
	const matches: BindingMatch[] = [];
	const project = isProjectActive(sources)
		? sources.project?.config
		: undefined;
	if (project) {
		for (const binding of project.bindings ?? []) {
			const match = matchBinding(binding, model, "project");
			if (match) {
				matches.push(match);
			}
		}
	}
	const global = sources.global.config;
	const inherit = project?.inheritGlobalBindings !== false;
	if (global && inherit) {
		for (const binding of global.bindings ?? []) {
			const match = matchBinding(binding, model, "global");
			if (match) {
				matches.push(match);
			}
		}
	}
	return matches;
}

function selectBinding(
	sources: ResolveSources,
	model: ModelIdentity,
	diagnostics: Diagnostic[],
) {
	const matches = collectBindings(sources, model);
	const byScope: Array<{ scope: Scope; matches: BindingMatch[] }> = [
		{
			scope: "project",
			matches: matches.filter((match) => match.scope === "project"),
		},
		{
			scope: "global",
			matches: matches.filter((match) => match.scope === "global"),
		},
	];
	const ignored: BindingMatch[] = [];
	for (const group of byScope) {
		const result = chooseBinding(group.matches, group.scope);
		if (result.conflict) {
			diagnostics.push(
				error(
					"binding-conflict",
					`Conflicting ${group.scope} bindings match ${model.provider}/${model.id}; no binding was applied from this scope.`,
				),
			);
			ignored.push(...result.ignored);
			// A project that defines conflicting rules does not fall through to
			// global bindings; that would contradict project-over-global scope.
			if (group.scope === "project") {
				return { ignored };
			}
			continue;
		}
		if (result.winner) {
			ignored.push(...result.ignored);
			return { winner: result.winner, ignored };
		}
	}
	return { ignored };
}

function expand(
	ref: ProfileRef,
	sources: ResolveSources,
	diagnostics: Diagnostic[],
) {
	const result = expandProfile(ref, createInheritDeps(sources));
	diagnostics.push(...result.diagnostics);
	return result.profile;
}

/**
 * Pure, deterministic resolution of the active profile for a selection and a
 * model. Returns `native` when the message must stay untouched.
 */
export function resolveProfile(
	selection: Selection,
	model: ModelIdentity | undefined,
	sources: ResolveSources,
	options: ResolveOptions = {},
): Resolution {
	const diagnostics: Diagnostic[] = [];

	if (selection.mode === "off") {
		return { mode: "off", ignored: [], diagnostics };
	}

	if (selection.mode === "manual") {
		const ref = selection.profile
			? resolveRef(selection.profile, "global")
			: undefined;
		if (!ref) {
			diagnostics.push(
				error(
					"selection-invalid",
					`Manual selection "${selection.profile ?? ""}" is not a valid profile reference.`,
				),
			);
			return { mode: "manual", ignored: [], diagnostics };
		}
		const profile = expand(ref, sources, diagnostics);
		return profile
			? { mode: "manual", profile, ignored: [], diagnostics }
			: { mode: "manual", ignored: [], diagnostics };
	}

	if (!model) {
		diagnostics.push(
			warn(
				"auto-no-model",
				"No model is selected yet; the profile will be resolved on the next run.",
			),
		);
		return { mode: "auto", ignored: [], diagnostics };
	}

	const project = isProjectActive(sources)
		? sources.project?.config
		: undefined;
	const global: ConfigV1 | undefined = sources.global.config;

	const selected = selectBinding(sources, model, diagnostics);
	if (selected.winner) {
		const scope = selected.winner.scope;
		const ref = resolveRef(selected.winner.binding.profile, scope);
		if (!ref) {
			diagnostics.push(
				error(
					"binding-profile",
					`Binding "${selected.winner.binding.id}" has an invalid profile reference.`,
				),
			);
		} else {
			const profile = expand(ref, sources, diagnostics);
			if (profile) {
				return {
					mode: "auto",
					profile,
					binding: selected.winner,
					ignored: selected.ignored,
					diagnostics,
				};
			}
		}
	}

	if (!options.bindingsOnly) {
		const defaults: Array<{ value: string; scope: Scope }> = [];
		if (project?.defaultProfile) {
			defaults.push({ value: project.defaultProfile, scope: "project" });
		}
		if (global?.defaultProfile) {
			defaults.push({ value: global.defaultProfile, scope: "global" });
		}
		for (const candidate of defaults) {
			const ref = resolveRef(candidate.value, candidate.scope);
			if (!ref) {
				diagnostics.push(
					error(
						"default-profile",
						`defaultProfile "${candidate.value}" is not a valid reference.`,
					),
				);
				continue;
			}
			const profile = expand(ref, sources, diagnostics);
			if (profile) {
				return {
					mode: "auto",
					profile,
					ignored: selected.ignored,
					diagnostics,
				};
			}
		}
	}

	diagnostics.push(
		info(
			"auto-none",
			options.bindingsOnly
				? `No binding matched ${model.provider}/${model.id}; the default profile is not used inside subagents.`
				: `No profile matched ${model.provider}/${model.id}; the message is sent as written.`,
		),
	);
	return { mode: "auto", ignored: selected.ignored, diagnostics };
}
