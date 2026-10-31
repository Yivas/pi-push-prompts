/**
 * Adapter runtime: the loaded profile state, the resolution for the current
 * model, the planned decoration, and the small API the `/push` commands call.
 *
 * The core does the pure work. This class owns everything that needs Pi: the
 * session branch, the current model, project trust and the atomic writes to
 * `config.json`. A finalizing message (`message_end`) reads only state that is
 * already loaded; the one thing there that can read from disk is `ensure`, when
 * the working directory or the project's trust changed since the last load.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	configPath,
	globalRoot,
	projectRoot,
} from "../core/paths.ts";
import { firstError } from "../core/diagnostics.ts";
import { decorate } from "../core/decorate.ts";
import { formatRef, resolveRef } from "../core/refs.ts";
import { isProjectActive, resolveProfile } from "../core/resolve.ts";
import type { ResolveSources } from "../core/resolve.ts";
import {
	type ConfigSnapshot,
	type LoadedState,
	loadState,
	readRawConfig,
	writeRawConfigIfUnchanged,
} from "../core/store.ts";
import {
	type Decoration,
	type Diagnostic,
	DEFAULT_DISPLAY,
	type DisplayMode,
	type ModelIdentity,
	type ProfileCatalog,
	type ProfileRef,
	type Resolution,
	type Scope,
	type Selection,
	type SourceConfig,
	type SubagentPolicy,
	type UserContent,
} from "../core/types.ts";
import {
	type AppliedView,
	recentApplied,
} from "./render.ts";
import {
	type BranchState,
	buildStateEntry,
	readBranchState,
	STATE_ENTRY_TYPE,
} from "./state.ts";

export function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `pi-subagents` marks child processes with this variable. A child loads the
 * extension too, so it must not inherit the parent's session selection.
 */
export function isSubagentRun(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1";
}

export function identityOf(
	model: ExtensionContext["model"],
): ModelIdentity | undefined {
	if (!model) {
		return undefined;
	}
	return { provider: String(model.provider), id: String(model.id) };
}

function modelKey(identity: ModelIdentity | undefined): string {
	return identity ? `${identity.provider}/${identity.id}` : "<none>";
}

/** One decoration ready to be applied and recorded. */
export interface DecorationPlan {
	decoration: Decoration;
	ref: ProfileRef;
	mode: "active" | "once";
	provider: string;
	model: string;
}

export interface PushStatus {
	selection: Selection;
	once?: string;
	display: DisplayMode;
	projectTrusted: boolean;
	model?: ModelIdentity;
	mode: Resolution["mode"];
	profile?: string;
	binding?: string;
	diagnostics: Diagnostic[];
}

export interface PushWhy {
	mode: Resolution["mode"];
	profile?: string;
	binding?: string;
	/** Scope the winning binding came from, for the sentence that explains it. */
	bindingScope?: Scope;
	ignored: string[];
	diagnostics: Diagnostic[];
}

/** Where the selection in force came from. */
export type SelectionOrigin = "config" | "session" | "flag";

export class Runtime {
	private readonly pi: ExtensionAPI;
	readonly agentDir: string;
	readonly configDirName: string;
	private loaded: LoadedState | undefined;
	private context: ExtensionContext | undefined;
	private selection: Selection = { mode: "auto" };
	/**
	 * The selection the branch stores, absent when the config baseline applies.
	 * Kept apart from `selection` because a flag overrides the latter in memory
	 * only and must not drop what the branch holds.
	 */
	private storedSelection: Selection | undefined;
	private origin: SelectionOrigin = "config";
	private once: string | undefined;
	private cached: { key: string; resolution: Resolution } | undefined;

	constructor(
		pi: ExtensionAPI,
		agentDir: string,
		configDirName: string,
	) {
		this.pi = pi;
		this.agentDir = agentDir;
		this.configDirName = configDirName;
	}

	/** Remembers the session this adapter is bound to; Pi replaces it on forks. */
	attach(ctx: ExtensionContext): void {
		this.context = ctx;
	}
	/**
	 * Drops every cached value so the next read goes back to disk and to the
	 * branch. Called by `session_start`, `session_tree`, `model_select` and the
	 * explicit reload command.
	 */
	reload(): void {
		this.loaded = undefined;
		this.cached = undefined;
		const ctx = this.context;
		if (!ctx) {
			return;
		}
		this.ensure(ctx);
		this.restoreBranch(ctx);
	}

	ensure(ctx: ExtensionContext): LoadedState {
		const trusted = ctx.isProjectTrusted();
		if (
			this.loaded &&
			this.loaded.cwd === ctx.cwd &&
			this.loaded.projectTrusted === trusted
		) {
			return this.loaded;
		}
		const changed = this.loaded !== undefined;
		this.loaded = loadState({
			cwd: ctx.cwd,
			agentDir: this.agentDir,
			configDirName: this.configDirName,
			projectTrusted: trusted,
		});
		this.cached = undefined;
		if (changed && this.origin === "config") {
			this.applyConfigBaseline();
		}
		return this.loaded;
	}

	sources(): ResolveSources {
		const loaded = this.loaded;
		if (!loaded) {
			throw new Error("push-prompts state was not loaded");
		}
		return {
			global: loaded.globalConfig,
			project: loaded.projectConfig,
			globalProfiles: loaded.globalProfiles,
			projectProfiles: loaded.projectProfiles,
			projectTrusted: loaded.projectTrusted,
		};
	}

	/** The profiles of one scope, as the last load found them. */
	catalog(scope: Scope): ProfileCatalog {
		const loaded = this.ensure(this.requireContext());
		return scope === "project" ? loaded.projectProfiles : loaded.globalProfiles;
	}

	/** One `config.json` as read, including the diagnostics about it. */
	configOf(scope: Scope): SourceConfig {
		const loaded = this.ensure(this.requireContext());
		return scope === "project" ? loaded.projectConfig : loaded.globalConfig;
	}

	/** Directory holding `config.json` and `profiles/` for one scope. */
	rootOf(scope: Scope): string {
		const loaded = this.ensure(this.requireContext());
		return scope === "project"
			? projectRoot(loaded.cwd, this.configDirName)
			: globalRoot(this.agentDir);
	}

	isTrusted(): boolean {
		return this.ensure(this.requireContext()).projectTrusted;
	}

	/** Whether a profile reference resolves to a profile currently loaded. */
	hasProfile(ref: ProfileRef): boolean {
		const loaded = this.ensure(this.requireContext());
		if (ref.scope === "project") {
			return loaded.projectTrusted && loaded.projectProfiles.profiles.has(ref.id);
		}
		return loaded.globalProfiles.profiles.has(ref.id);
	}

	/** Where the selection in force came from: a config file, the branch, or a CLI flag. */
	selectionOrigin(): SelectionOrigin {
		return this.origin;
	}

	/**
	 * Rebuilds `once` and the stored selection from the entries on the active
	 * branch. A run flag is not on the branch, so a reload keeps it in force: only
	 * an explicit `/push` command stores a selection in its place.
	 */
	private restoreBranch(ctx: ExtensionContext): void {
		const state: BranchState = readBranchState(ctx.sessionManager);
		this.once = state.once;
		this.storedSelection = state.selection;
		this.cached = undefined;
		if (this.origin === "flag") {
			return;
		}
		if (state.selection) {
			this.selection = state.selection;
			this.origin = "session";
			return;
		}
		this.applyConfigBaseline();
	}

	/**
	 * The config selection is only a baseline: a session selection stored on the
	 * branch wins over it, and `once` wins over both for one message.
	 */
	private applyConfigBaseline(): void {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		this.cached = undefined;
		const sources = this.sources();
		const projectSelection = isProjectActive(sources)
			? loaded.projectConfig.config?.selection
			: undefined;
		const scope: Scope = projectSelection ? "project" : "global";
		const baseline = projectSelection ?? loaded.globalConfig.config?.selection;
		this.origin = "config";
		if (!baseline) {
			this.selection = { mode: "auto" };
			return;
		}
		if (baseline.mode === "manual") {
			const ref = resolveRef(baseline.profile, scope);
			this.selection = ref
				? { mode: "manual", profile: formatRef(ref) }
				: { mode: "auto" };
			return;
		}
		this.selection = { mode: baseline.mode };
	}

	private subagentPolicy(loaded: LoadedState): SubagentPolicy {
		const project = isProjectActive(this.sources())
			? loaded.projectConfig.config?.subagents
			: undefined;
		return project ?? loaded.globalConfig.config?.subagents ?? "bindings";
	}

	private requireContext(): ExtensionContext {
		if (!this.context) {
			throw new Error("push-prompts is not attached to a session yet");
		}
		return this.context;
	}

	/** Resolution for the current model, cached until something invalidates it. */
	resolve(): { resolution: Resolution; identity: ModelIdentity | undefined } {
		const ctx = this.requireContext();
		const loaded = this.ensure(ctx);
		const identity = identityOf(ctx.model);
		const policy: SubagentPolicy = isSubagentRun()
			? this.subagentPolicy(loaded)
			: "inherit";
		const base: Selection =
			this.once !== undefined
				? { mode: "manual", profile: this.once }
				: this.selection;

		let selection: Selection = base;
		let bindingsOnly = false;
		if (policy === "off" || base.mode === "off") {
			// An explicit `off` always wins, including inside a subagent.
			selection = { mode: "off" };
		} else if (policy === "bindings") {
			selection = { mode: "auto" };
			bindingsOnly = true;
		}

		const key = [
			modelKey(identity),
			policy,
			selection.mode,
			selection.mode === "manual" ? (selection.profile ?? "") : "",
		].join("|");
		if (this.cached?.key === key) {
			return { resolution: this.cached.resolution, identity };
		}

		const resolution = resolveProfile(
			selection,
			identity,
			this.sources(),
			{ bindingsOnly },
		);
		this.cached = { key, resolution };
		return { resolution, identity };
	}

	/**
	 * Plans the decoration of one finalized user message, or returns undefined
	 * when no profile applies. Reads only state that is already loaded.
	 */
	plan(content: UserContent): DecorationPlan | undefined {
		const { resolution, identity } = this.resolve();
		const profile = resolution.profile;
		if (!profile) {
			return undefined;
		}
		const decoration = decorate(content, profile.layers);
		if (!decoration) {
			return undefined;
		}
		return {
			decoration,
			ref: profile.ref,
			mode: this.once !== undefined ? "once" : "active",
			provider: identity?.provider ?? "",
			model: identity?.id ?? "",
		};
	}

	/**
	 * The diagnostics this session's resolution produced. `/push validate` lists
	 * them next to the state diagnostics, so the code named by a blocking notice
	 * can be found without sending a message first.
	 */
	resolutionDiagnostics(): Diagnostic[] {
		return this.resolve().resolution.diagnostics;
	}

	/** The first failure that means Push cannot decide what to apply. */
	precheck(): Diagnostic | undefined {
		const { resolution } = this.resolve();
		// An explicit `off` needs nothing read from disk. Keeping it open when a
		// file is broken gives the user a way to keep working: turn Push off.
		if (resolution.mode === "off") {
			return undefined;
		}
		// Damage to a config file or to the profile catalogue counts even when it
		// would not change today's answer: the user asked for a profile and cannot
		// tell what was read.
		const state = firstError(this.diagnostics());
		if (state) {
			return state;
		}
		return firstError(resolution.diagnostics);
	}

	/**
	 * Whether a profile could still apply, judged only from what is in memory.
	 * The `input` handler asks this after the check itself has failed: with an
	 * explicit `off` nothing can be added, so the send is left alone; in every
	 * other mode it stops instead of sending something it could not check.
	 */
	mayApplyProfile(): boolean {
		return this.once !== undefined || this.selection.mode !== "off";
	}

	/**
	 * Clears `once` and records it on the branch. It is consumed when a message
	 * was decorated with it and disarmed when Pi forks or navigates the tree, so
	 * an earlier point can never resurrect it.
	 */
	clearOnce(): boolean {
		if (this.once === undefined) {
			return false;
		}
		this.once = undefined;
		this.cached = undefined;
		this.persistState();
		return true;
	}

	private persistState(): void {
		this.pi.appendEntry(
			STATE_ENTRY_TYPE,
			buildStateEntry(this.storedSelection, this.once),
		);
	}

	normalizeSelection(selection: Selection): Selection {
		if (selection.mode !== "manual") {
			return selection;
		}
		const ref = resolveRef(selection.profile ?? "", "global");
		if (!ref) {
			throw new Error(
				`"${selection.profile ?? ""}" is not a valid profile reference (use an id, global:id or project:id).`,
			);
		}
		return { mode: "manual", profile: formatRef(ref) };
	}

	/** Stores a session selection on the active branch. */
	setSelection(selection: Selection): void {
		const normalized = this.normalizeSelection(selection);
		this.selection = normalized;
		this.storedSelection = normalized;
		this.origin = "session";
		this.cached = undefined;
		this.persistState();
	}

	/**
	 * Applies a choice that came from a command-line flag. It lives in memory for
	 * this process only: no entry is written and the stored selection is left
	 * alone, so a later session choice, a reload of the session file and a reopen
	 * are unaffected, and admitting the flag cannot change what a stored message
	 * says.
	 */
	applyFlagSelection(selection: Selection): void {
		this.selection = this.normalizeSelection(selection);
		this.origin = "flag";
		this.cached = undefined;
	}

	/** Arms a profile for the next finalized user message. */
	armOnce(reference: string): void {
		const ref = resolveRef(reference, "global");
		if (!ref) {
			throw new Error(
				`"${reference}" is not a valid profile reference (use an id, global:id or project:id).`,
			);
		}
		this.cached = undefined;
		this.once = formatRef(ref);
		this.persistState();
	}

	cancelOnce(): boolean {
		return this.clearOnce();
	}

	display(): DisplayMode {
		const loaded = this.loaded;
		if (!loaded) {
			return DEFAULT_DISPLAY;
		}
		const project = isProjectActive(this.sources())
			? loaded.projectConfig.config?.display
			: undefined;
		return project ?? loaded.globalConfig.config?.display ?? DEFAULT_DISPLAY;
	}

	/**
	 * Writes the presentation-only `display` setting through the same atomic,
	 * compare-before-write path as every other config change.
	 */
	setDisplay(scope: Scope, mode: DisplayMode): void {
		const loaded = this.ensure(this.requireContext());
		if (scope === "project" && !loaded.projectTrusted) {
			throw new Error(
				"The project is not trusted, so its configuration is not written.",
			);
		}
		const file =
			scope === "global"
				? configPath(globalRoot(this.agentDir))
				: configPath(projectRoot(loaded.cwd, this.configDirName));
		const snapshot: ConfigSnapshot = readRawConfig(file);
		if (snapshot.exists && snapshot.config.version !== 1) {
			throw new Error(
				`${file}: unsupported version ${JSON.stringify(snapshot.config.version)}; the file was not changed.`,
			);
		}
		writeRawConfigIfUnchanged(file, snapshot, {
			...snapshot.config,
			version: 1,
			display: mode,
		});
		this.reload();
	}

	/**
	 * Decorated messages of the active branch, newest last, for `/push show`.
	 * The branch, not the whole tree: a fork or a navigation must not show what
	 * another branch did.
	 */
	listApplied(count: number): AppliedView[] {
		return recentApplied(
			this.requireContext().sessionManager.getBranch(),
			count,
		);
	}

	/**
	 * Entries of the active branch, for the native-row transformer. Pi paints the
	 * messages of the active branch, so only those entries may rewrite a row.
	 */
	activeBranchEntries(): readonly SessionEntry[] {
		return this.context ? this.context.sessionManager.getBranch() : [];
	}

	diagnostics(): Diagnostic[] {
		return this.loaded?.diagnostics ?? [];
	}

	errorDiagnostics(): Diagnostic[] {
		return this.diagnostics().filter((entry) => entry.level === "error");
	}

	getStatus(): PushStatus {
		const ctx = this.requireContext();
		const { resolution, identity } = this.resolve();
		const status: PushStatus = {
			selection: this.selection,
			display: this.display(),
			projectTrusted: ctx.isProjectTrusted(),
			mode: resolution.mode,
			diagnostics: this.diagnostics(),
		};
		if (this.once !== undefined) {
			status.once = this.once;
		}
		if (identity) {
			status.model = identity;
		}
		if (resolution.profile) {
			status.profile = formatRef(resolution.profile.ref);
		}
		if (resolution.binding) {
			status.binding = resolution.binding.binding.id;
		}
		return status;
	}

	/** Why the current model got no profile, or which rule gave it one. */
	why(): PushWhy {
		const { resolution } = this.resolve();
		const why: PushWhy = {
			mode: resolution.mode,
			ignored: resolution.ignored.map(
				(match) =>
					`${match.binding.id} (${match.scope}, profile ${match.binding.profile})`,
			),
			diagnostics: resolution.diagnostics,
		};
		if (resolution.profile) {
			why.profile = formatRef(resolution.profile.ref);
		}
		if (resolution.binding) {
			why.binding = resolution.binding.binding.id;
			why.bindingScope = resolution.binding.scope;
		}
		return why;
	}
}
