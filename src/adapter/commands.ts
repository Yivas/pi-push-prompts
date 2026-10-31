/**
 * The `/push` command: the menu, the subcommands and the CLI flags.
 *
 * Derived from pi-prompt-profiles src/adapter/commands.ts at 3f6d583 (MIT).
 * The differences come from this product's contract, not from taste:
 * - a profile is a directory with `prepend.md` and `append.md`, not one file
 *   of system prompt text, and nothing here touches the system prompt;
 * - `once` arms a profile for the next finalized message, `show` reads back a
 *   send, and `display` only changes what the transcript paints;
 * - every sentence a person reads lives in `src/i18n/en.ts`.
 *
 * Nothing in this file may alter a serialized request. Commands read the loaded
 * state, write config and profile files, and store branch entries; the message
 * Pi finalizes is decorated in one place only, the `message_end` handler.
 */

import fs from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { insertionOf, normalizeProfileText } from "../core/decorate.ts";
import { isSafeId, suggestId } from "../core/ids.ts";
import { matchRule } from "../core/match.ts";
import {
	atomicWriteFile,
	configPath,
	isRealPathInside,
} from "../core/paths.ts";
import {
	allModels,
	type PickerItem,
	modelsOfProvider,
	providerNames,
} from "../core/picker.ts";
import { APPEND_FILE, DEFAULT_MAX_PROFILE_BYTES, PREPEND_FILE } from "../core/profiles.ts";
import { formatRef, parseRef, resolveRef } from "../core/refs.ts";
import { isProjectActive } from "../core/resolve.ts";
import {
	applySetting,
	effectiveSetting,
	isProjectOnly,
	parseSetting,
	type SettingKey,
	type SettingProblem,
	type SettingSpec,
	settingKeys,
	settingSpec,
	unsetSetting,
} from "../core/settings.ts";
import {
	type ConfigSnapshot,
	readRawConfig,
	writeRawConfigIfUnchanged,
} from "../core/store.ts";
import {
	type Binding,
	DISPLAY_MODES,
	type Diagnostic,
	type ModelIdentity,
	type ProfileRef,
	type Scope,
	type Selection,
} from "../core/types.ts";
import { en } from "../i18n/en.ts";
import { selectItem } from "./picker.ts";
import { messageOf, type Runtime } from "./runtime.ts";

const COMMAND_NAME = "push";
const FLAG_PROFILE = "push-profile";
const FLAG_AUTO = "push-auto";
const FLAG_OFF = "push-off";

/** Longest side of a preview, so a large profile cannot flood the transcript. */
const PREVIEW_LIMIT = 800;

type ProfilePart = "prepend" | "append";

interface ParsedArgs {
	positional: string[];
	flags: Record<string, string | boolean>;
}

export function parseArgs(input: string): ParsedArgs {
	const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token.startsWith("--")) {
			const equals = token.indexOf("=");
			if (equals > 0) {
				flags[token.slice(2, equals)] = token.slice(equals + 1);
				continue;
			}
			const key = token.slice(2);
			const next = tokens[index + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				index += 1;
			} else {
				flags[key] = true;
			}
			continue;
		}
		positional.push(token.replace(/^['"]|['"]$/g, ""));
	}
	return { positional, flags };
}

function flagString(
	flags: Record<string, string | boolean>,
	name: string,
): string | undefined {
	const value = flags[name];
	return typeof value === "string" ? value : undefined;
}

function flagNumber(
	flags: Record<string, string | boolean>,
	name: string,
): number | undefined {
	const value = flagString(flags, name);
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function notify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	ctx.ui.notify(message, type);
}

interface ScopeFlag {
	scope?: Scope;
	/** The raw bad value, when `--scope` was not global or project. */
	invalid?: string;
}

function parseScope(flags: Record<string, string | boolean>): ScopeFlag {
	const value = flags.scope;
	if (value === undefined) {
		return {};
	}
	if (value === true || value === false) {
		return { scope: undefined, invalid: value === true ? "" : String(value) };
	}
	if (value === "global" || value === "project") {
		return { scope: value };
	}
	return { invalid: value };
}

/** Reports an unusable `--scope`; `true` means the caller must stop. */
function rejectInvalidScope(ctx: ExtensionCommandContext, flag: ScopeFlag): boolean {
	if (flag.invalid === undefined) {
		return false;
	}
	notify(
		ctx,
		flag.invalid === ""
			? en.args.missingScope
			: en.args.invalidScope(flag.invalid),
		"error",
	);
	return true;
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
	return diagnostics
		.map((entry) => `${entry.level}: ${entry.message}`)
		.join("\n");
}

/**
 * Same shape the blocking notice uses. A send stopped by the pre-check prints
 * `[code]`, so `/push validate` has to print it too or the user has nothing to
 * search for.
 */
function formatDiagnosticsWithCodes(diagnostics: Diagnostic[]): string {
	return diagnostics
		.map((entry) => `${entry.level}: [${entry.code}] ${entry.message}`)
		.join("\n");
}

function selectionText(selection: Selection): string {
	return selection.mode === "manual"
		? (selection.profile ?? selection.mode)
		: selection.mode;
}

/** One profile as the lists show it: reference, directory, description. */
interface ProfileEntry {
	ref: ProfileRef;
	label: string;
	part: ProfilePart;
}

function partWithText(prepend: string, append: string): ProfilePart {
	if (normalizeProfileText(prepend) !== "") {
		return "prepend";
	}
	return normalizeProfileText(append) !== "" ? "append" : "prepend";
}

function profileEntries(runtime: Runtime): ProfileEntry[] {
	const entries: ProfileEntry[] = [];
	const scopes: Scope[] = runtime.isTrusted()
		? ["project", "global"]
		: ["global"];
	for (const scope of scopes) {
		for (const profile of runtime.catalog(scope).profiles.values()) {
			const ref: ProfileRef = { scope, id: profile.id };
			const suffix = profile.description ? ` · ${profile.description}` : "";
			entries.push({
				ref,
				label: `${formatRef(ref)} — ${profile.path}${suffix}`,
				part: partWithText(profile.prepend, profile.append),
			});
		}
	}
	return entries;
}

function findProfileRef(runtime: Runtime, input: string): ProfileRef | string {
	const explicit = parseRef(input);
	if (explicit) {
		return explicit;
	}
	if (!isSafeId(input)) {
		return en.profiles.invalidId(input);
	}
	if (runtime.isTrusted() && runtime.catalog("project").profiles.has(input)) {
		return { scope: "project", id: input };
	}
	if (runtime.catalog("global").profiles.has(input)) {
		return { scope: "global", id: input };
	}
	return en.profiles.notFound(input);
}

function profileOf(runtime: Runtime, ref: ProfileRef) {
	return runtime.catalog(ref.scope).profiles.get(ref.id);
}

function rootOf(runtime: Runtime, scope: Scope): string {
	return runtime.rootOf(scope);
}

function profileDir(runtime: Runtime, ref: ProfileRef): string {
	return path.join(rootOf(runtime, ref.scope), "profiles", ref.id);
}

function configRoot(runtime: Runtime, scope: Scope): string {
	return configPath(rootOf(runtime, scope));
}

/**
 * Reads, mutates and writes one `config.json`. The write only happens when the
 * file still holds what was read, and the whole object is rewritten, which is
 * what preserves fields this build does not know.
 */
function editConfig(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	scope: Scope,
	mutate: (config: Record<string, unknown>) => boolean,
): boolean {
	if (scope === "project" && !ctx.isProjectTrusted()) {
		throw new Error(en.profiles.untrustedProject);
	}
	const filePath = configRoot(runtime, scope);
	const snapshot: ConfigSnapshot = readRawConfig(filePath);
	if (snapshot.config.version !== 1) {
		throw new Error(
			`${filePath}: unsupported version ${JSON.stringify(snapshot.config.version)}; the file was not changed.`,
		);
	}
	if (mutate(snapshot.config) === false) {
		return false;
	}
	writeRawConfigIfUnchanged(filePath, snapshot, snapshot.config);
	return true;
}

function listProfileLines(runtime: Runtime, scope: Scope | undefined): string[] {
	const scopes: Scope[] =
		scope === undefined
			? runtime.isTrusted()
				? ["project", "global"]
				: ["global"]
			: [scope];
	const lines: string[] = [];
	for (const current of scopes) {
		for (const profile of runtime.catalog(current).profiles.values()) {
			const suffix = profile.description ? ` — ${profile.description}` : "";
			lines.push(
				`${formatRef({ scope: current, id: profile.id })} — ${profile.path}${suffix}`,
			);
		}
	}
	return lines;
}

async function chooseProfileInteractive(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	title: string,
): Promise<void> {
	const entries = profileEntries(runtime);
	if (entries.length === 0) {
		notify(ctx, en.profiles.none, "warning");
		return;
	}
	const choice = await selectItem(ctx, {
		title,
		items: [
			{ value: "__auto__", label: en.selection.auto },
			...entries.map((entry) => ({
				value: formatRef(entry.ref),
				label: entry.label,
			})),
			{ value: "__off__", label: en.selection.off },
		],
	});
	if (choice === undefined) {
		return;
	}
	if (choice === "__auto__") {
		runtime.setSelection({ mode: "auto" });
		notify(ctx, en.selection.auto);
		return;
	}
	if (choice === "__off__") {
		runtime.setSelection({ mode: "off" });
		notify(ctx, en.selection.off);
		return;
	}
	const ref = parseRef(choice);
	if (!ref) {
		return;
	}
	runtime.setSelection({ mode: "manual", profile: formatRef(ref) });
	notify(ctx, en.selection.manual(formatRef(ref)));
}

async function pickProfileRef(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	title: string,
): Promise<ProfileEntry | undefined> {
	const entries = profileEntries(runtime);
	if (entries.length === 0) {
		notify(ctx, en.profiles.none, "warning");
		return undefined;
	}
	const choice = await selectItem(ctx, {
		title,
		items: entries.map((entry) => ({
			value: formatRef(entry.ref),
			label: entry.label,
		})),
	});
	return entries.find((entry) => formatRef(entry.ref) === choice);
}

function scopeItems(ctx: ExtensionCommandContext): PickerItem[] {
	const items: PickerItem[] = [];
	if (ctx.isProjectTrusted()) {
		items.push({ value: "project", label: en.args.scope("project") });
	}
	items.push({ value: "global", label: en.args.scope("global") });
	return items;
}

async function chooseScopeInteractive(
	ctx: ExtensionCommandContext,
	title: string = en.menu.scopeTitle,
): Promise<Scope | undefined> {
	const choice = await selectItem(ctx, { title, items: scopeItems(ctx) });
	return choice === "global" || choice === "project" ? choice : undefined;
}

function effectiveSettingFor(
	runtime: Runtime,
	key: SettingKey,
): ReturnType<typeof effectiveSetting> {
	const projectActive = isProjectActive(runtime.sources());
	return effectiveSetting(
		{
			global: runtime.configOf("global").config,
			project: projectActive ? runtime.configOf("project").config : undefined,
			projectActive,
		},
		key,
	);
}

function describeProblem(problem: SettingProblem): string {
	switch (problem.code) {
		case "unknown":
			return en.settings.unknownKey(problem.input, settingKeys().join(", "));
		case "own-command":
			return en.settings.needsOwnCommand(problem.key);
		case "value":
			return en.settings.invalidValue(problem.key, problem.values.join(", "));
		case "boolean":
			return en.settings.booleanValue(problem.key);
		case "not-set":
			return en.settings.notSet(problem.key);
	}
}

function reportSettingProblem(
	ctx: ExtensionCommandContext,
	problem: SettingProblem,
): void {
	notify(ctx, describeProblem(problem), "error");
}

async function changeSettingInteractive(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const scope = await chooseScopeInteractive(
		ctx,
		en.menu.settingScopeTitle,
	);
	if (!scope) {
		return;
	}
	const items: PickerItem[] = [];
	for (const key of settingKeys()) {
		const spec = settingSpec(key);
		if (!spec?.settable || isProjectOnly(spec, scope)) {
			continue;
		}
		const effective = effectiveSettingFor(runtime, key);
		items.push({
			value: key,
			label: `${key} — ${en.settings.describe[key]} (now: ${JSON.stringify(effective.value)} from ${effective.origin})`,
		});
	}
	const key = await selectItem(ctx, {
		title: en.menu.settingTitle(scope),
		items,
	});
	if (!key) {
		return;
	}
	const spec = settingSpec(key);
	if (!spec) {
		return;
	}
	const values = spec.values ?? ["true", "false"];
	const value = await selectItem(ctx, {
		title: en.menu.settingValueTitle(spec.key, scope),
		items: values.map((entry) => ({ value: entry, label: entry })),
	});
	if (value === undefined) {
		return;
	}
	setConfigSetting(runtime, ctx, key, value, scope);
}

/** Writes one setting, then reports what the write means for this session. */
function setConfigSetting(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	rawKey: string,
	rawValue: string,
	scope: Scope,
): void {
	const parsed = parseSetting(rawKey, rawValue);
	if (!parsed.ok) {
		reportSettingProblem(ctx, parsed.problem);
		return;
	}
	if (isProjectOnly(parsed.spec, scope)) {
		notify(ctx, en.settings.projectOnly(parsed.spec.key), "error");
		return;
	}
	let droppedManual = false;
	try {
		editConfig(runtime, ctx, scope, (config) => {
			const selection = config.selection;
			if (
				parsed.spec.key === "selection" &&
				typeof selection === "object" &&
				selection !== null &&
				(selection as { mode?: unknown }).mode === "manual"
			) {
				droppedManual = true;
			}
			applySetting(config, parsed.spec, parsed.value);
			return true;
		});
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	notify(
		ctx,
		en.settings.set(
			parsed.spec.key,
			JSON.stringify(parsed.value),
			scope,
		),
	);
	if (droppedManual) {
		notify(ctx, en.settings.droppedManual, "warning");
	}
	reloadAfterWrite(runtime, ctx, parsed.spec.key);
	if (parsed.spec.key === "display") {
		notify(ctx, en.display.set(runtime.display(), scope));
	}
}

/** Reloads and reports; a failed reload never hides a successful write. */
function reloadAfterWrite(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	key: SettingKey | undefined,
): void {
	try {
		runtime.attach(ctx);
		runtime.reload();
	} catch (cause) {
		notify(ctx, en.config.writtenNotReloaded(messageOf(cause)), "error");
		return;
	}
	const errors = runtime.errorDiagnostics();
	if (errors.length > 0) {
		notify(ctx, en.config.stillBroken(formatDiagnostics(errors)), "error");
		return;
	}
	if (key === "selection" && runtime.selectionOrigin() === "session") {
		notify(ctx, en.settings.sessionKeepsSelection);
	}
	if (key === "subagents") {
		notify(ctx, en.settings.subagentsTakeEffect);
	}
}

async function interactiveMenu(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const actions: PickerItem[] = [
		{ value: "choose", label: en.menu.chooseProfile },
		{ value: "once", label: en.menu.armOnce },
		...(runtime.getStatus().once === undefined
			? []
			: [{ value: "cancel-once", label: en.menu.cancelOnce }]),
		{ value: "list", label: en.menu.listProfiles },
		{ value: "new", label: en.menu.createProfile },
		{ value: "edit", label: en.menu.editProfile },
		{ value: "bindings", label: en.menu.bindings },
		{ value: "default", label: en.menu.defaultProfile },
		{ value: "display", label: en.menu.showAddedText },
		{ value: "status", label: en.menu.status },
		{ value: "why", label: en.menu.why },
		{ value: "preview", label: en.menu.preview },
		{ value: "show", label: en.menu.showLast },
		{ value: "config", label: en.menu.config },
		{ value: "setting", label: en.menu.changeSetting },
		{ value: "validate", label: en.menu.validate },
		{ value: "reload", label: en.menu.reload },
		{ value: "off", label: en.menu.turnOff },
		{ value: "help", label: en.menu.help },
	];
	const choice = await selectItem(ctx, {
		title: en.menu.title,
		items: actions,
	});
	switch (choice) {
		case undefined:
			return;
		case "choose":
			await chooseProfileInteractive(runtime, ctx, en.menu.chooseProfileTitle);
			return;
		case "once": {
			const entry = await pickProfileRef(runtime, ctx, en.menu.armOnceTitle);
			if (entry) {
				armOnce(runtime, ctx, formatRef(entry.ref));
			}
			return;
		}
		case "cancel-once":
			cancelOnce(runtime, ctx);
			return;
		case "list":
			notify(ctx, listProfileLines(runtime, undefined).join("\n") || en.profiles.noneInScope);
			return;
		case "new":
			await createProfileInteractive(runtime, ctx);
			return;
		case "edit": {
			const entry = await pickProfileRef(runtime, ctx, en.menu.editProfileTitle);
			if (entry) {
				await editProfileInteractive(runtime, ctx, entry.ref);
			}
			return;
		}
		case "bindings":
			await bindingsMenu(runtime, ctx);
			return;
		case "default": {
			const entry = await pickProfileRef(
				runtime,
				ctx,
				en.menu.defaultProfileTitle,
			);
			if (entry) {
				setDefaultProfile(runtime, ctx, formatRef(entry.ref), entry.ref.scope);
			}
			return;
		}
		case "display":
			await chooseDisplayInteractive(runtime, ctx);
			return;
		case "status":
			notify(ctx, statusText(runtime, ctx));
			return;
		case "why":
			notify(ctx, whyText(runtime, ctx));
			return;
		case "preview":
			handlePreview(runtime, ctx);
			return;
		case "show":
			handleShow(runtime, ctx, 1);
			return;
		case "config": {
			const scope = await chooseScopeInteractive(ctx);
			if (scope) {
				handleConfig(runtime, ctx, scope);
			}
			return;
		}
		case "setting":
			await changeSettingInteractive(runtime, ctx);
			return;
		case "validate":
			notify(ctx, validateText(runtime, ctx));
			return;
		case "reload":
			handleReload(runtime, ctx);
			return;
		case "off":
			runtime.setSelection({ mode: "off" });
			notify(ctx, en.selection.off);
			return;
		case "help":
			notify(ctx, en.help.join("\n"));
	}
}

/**
 * The `display` entry: it changes only what the transcript paints. It asks for
 * the scope first, because a project setting and a global setting are different
 * decisions, and offers the project only when it is trusted.
 */
async function chooseDisplayInteractive(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const scope = await chooseScopeInteractive(ctx, en.menu.displayScopeTitle);
	if (!scope) {
		return;
	}
	const choice = await selectItem(ctx, {
		title: en.menu.displayTitle,
		items: [
			{ value: "hidden", label: en.menu.displayHidden },
			{ value: "added", label: en.menu.displayAdded },
		],
	});
	const mode = DISPLAY_MODES.find((entry) => entry === choice);
	if (!mode) {
		return;
	}
	try {
		runtime.setDisplay(scope, mode);
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	notify(ctx, en.display.set(mode, scope));
}

function statusText(runtime: Runtime, _ctx: ExtensionCommandContext): string {
	const status = runtime.getStatus();
	const { resolution } = runtime.resolve();
	const lines = [
		en.status.title,
		en.status.selection(selectionText(status.selection)),
		en.status.origin(runtime.selectionOrigin()),
	];
	if (status.once !== undefined) {
		lines.push(en.status.once(status.once));
	}
	lines.push(
		en.status.model(
			status.model
				? `${status.model.provider}/${status.model.id}`
				: en.status.none,
		),
	);
	lines.push(
		status.profile
			? en.status.resolved(status.profile)
			: en.status.resolvedNone,
	);
	if (resolution.profile) {
		lines.push(
			en.status.layers(
				resolution.profile.layers.map((layer) => formatRef(layer.ref)).join(" -> "),
			),
		);
	}
	if (status.binding) {
		lines.push(en.status.binding(status.binding));
	}
	lines.push(en.status.display(status.display));
	lines.push(en.status.trust(status.projectTrusted));
	lines.push(en.status.diagnostics(status.diagnostics.length));
	if (status.diagnostics.length > 0) {
		lines.push(formatDiagnostics(status.diagnostics));
	}
	return lines.join("\n");
}

function whyText(runtime: Runtime, ctx: ExtensionCommandContext): string {
	const why = runtime.why();
	const status = runtime.getStatus();
	const lines = [statusText(runtime, ctx), ""];
	if (why.mode === "off") {
		lines.push(en.why.off);
	} else if (why.profile && why.binding) {
		lines.push(
			en.why.binding(
				why.binding,
				why.bindingScope ?? "global",
				why.profile,
			),
		);
	} else if (why.profile && status.selection.mode === "manual") {
		lines.push(en.why.manual(why.profile));
	} else if (why.profile) {
		lines.push(en.why.defaultProfile(why.profile));
	} else if (!status.model) {
		lines.push(en.why.noModel);
	} else {
		lines.push(en.why.none(`${status.model.provider}/${status.model.id}`));
	}
	if (why.ignored.length > 0) {
		lines.push(en.why.ignored(why.ignored.join(", ")));
	}
	if (why.diagnostics.length > 0) {
		lines.push(formatDiagnostics(why.diagnostics));
	}
	return lines.join("\n");
}

function validateText(runtime: Runtime, ctx: ExtensionCommandContext): string {
	const global = runtime.configOf("global");
	const project = runtime.configOf("project");
	const trusted = ctx.isProjectTrusted();
	// What the pre-check reads, in the order it reads it: damage to a file or to
	// the catalogue first, then the resolution diagnostics that stop a send. Only
	// the errors of the resolution count, because that is all the pre-check acts
	// on; the notes it leaves for an unconfigured install are not problems.
	const diagnostics = [
		...runtime.diagnostics(),
		...runtime
			.resolutionDiagnostics()
			.filter((entry) => entry.level === "error"),
	];
	const status = runtime.getStatus();
	const lines = [
		en.validate.title,
		en.validate.globalConfig(global.exists ? en.validate.present : en.validate.absent),
		en.validate.projectConfig(
			trusted
				? project.exists
					? en.validate.present
					: en.validate.absent
				: en.validate.notRead,
		),
		en.validate.trust(trusted),
		en.validate.globalProfiles(runtime.catalog("global").profiles.size),
		en.validate.projectProfiles(
			trusted ? runtime.catalog("project").profiles.size : 0,
		),
		status.profile
			? en.validate.resolved(status.profile)
			: en.validate.resolvedNone,
		en.validate.diagnostics(diagnostics.length),
	];
	if (diagnostics.length > 0) {
		lines.push(formatDiagnosticsWithCodes(diagnostics));
	} else {
		lines.push(en.validate.clean);
	}
	return lines.join("\n");
}

function handleList(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): void {
	const scopeFlag = parseScope(args.flags);
	if (rejectInvalidScope(ctx, scopeFlag)) {
		return;
	}
	// The project list is empty for a reason worth naming: nothing was read.
	if (scopeFlag.scope === "project" && !ctx.isProjectTrusted()) {
		notify(ctx, en.profiles.untrustedProject, "warning");
		return;
	}
	const lines = listProfileLines(runtime, scopeFlag.scope);
	notify(ctx, lines.length > 0 ? lines.join("\n") : en.profiles.noneInScope);
}

function handleUse(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): void {
	const input = args.positional[0];
	if (!input) {
		notify(ctx, en.command.usage, "warning");
		return;
	}
	const ref = findProfileRef(runtime, input);
	if (typeof ref === "string") {
		notify(ctx, ref, "error");
		return;
	}
	if (!runtime.hasProfile(ref)) {
		notify(ctx, en.profiles.notFound(formatRef(ref)), "error");
		return;
	}
	runtime.setSelection({ mode: "manual", profile: formatRef(ref) });
	notify(ctx, en.selection.manual(formatRef(ref)));
}

function armOnce(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	input: string,
): void {
	const ref = findProfileRef(runtime, input);
	if (typeof ref === "string") {
		notify(ctx, ref, "error");
		return;
	}
	if (!runtime.hasProfile(ref)) {
		notify(ctx, en.profiles.notFound(formatRef(ref)), "error");
		return;
	}
	runtime.armOnce(formatRef(ref));
	notify(ctx, en.selection.onceArmed(formatRef(ref)));
}

function cancelOnce(runtime: Runtime, ctx: ExtensionCommandContext): void {
	const cleared = runtime.cancelOnce();
	notify(ctx, cleared ? en.selection.onceCancelled : en.selection.onceNone);
}

function handleOnce(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): void {
	const input = args.positional[0];
	if (!input) {
		notify(ctx, en.command.usage, "warning");
		return;
	}
	if (input === "off") {
		cancelOnce(runtime, ctx);
		return;
	}
	armOnce(runtime, ctx, input);
}

function setDefaultProfile(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	input: string,
	scopeFlag: Scope | undefined,
): void {
	const explicit = parseRef(input);
	const scope: Scope = scopeFlag ?? explicit?.scope ?? "global";
	const id = explicit?.id ?? input;
	if (!isSafeId(id)) {
		notify(ctx, en.profiles.invalidId(id), "error");
		return;
	}
	if (!runtime.hasProfile({ scope, id })) {
		notify(ctx, en.profiles.defaultMissing(`${scope}:${id}`), "error");
		return;
	}
	const value = formatRef({ scope, id });
	try {
		editConfig(runtime, ctx, scope, (config) => {
			config.defaultProfile = value;
			return true;
		});
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	reloadAfterWrite(runtime, ctx, "defaultProfile");
	notify(ctx, en.profiles.defaultSet(value, scope));
}

function handleDefault(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): void {
	const input = args.positional[0];
	if (!input) {
		notify(ctx, en.command.usage, "warning");
		return;
	}
	const scopeFlag = parseScope(args.flags);
	if (rejectInvalidScope(ctx, scopeFlag)) {
		return;
	}
	setDefaultProfile(runtime, ctx, input, scopeFlag.scope);
}

/**
 * Refuses text the loader would drop, before anything is written. The bytes
 * measured are the ones the loader will read, including the trailing newline an
 * editor would keep, and the loader reports an oversize file as
 * `profile-too-large` instead of loading it.
 */
function assertProfilePartFits(
	ref: ProfileRef,
	part: ProfilePart,
	text: string,
): void {
	const content = text.endsWith("\n") ? text : `${text}\n`;
	if (Buffer.byteLength(content, "utf8") > DEFAULT_MAX_PROFILE_BYTES) {
		throw new Error(
			en.profiles.tooLarge(formatRef(ref), part, DEFAULT_MAX_PROFILE_BYTES),
		);
	}
}

/** Refuses to write anything outside the authorized root of a scope. */
function writeProfilePart(
	runtime: Runtime,
	ref: ProfileRef,
	part: ProfilePart,
	text: string,
): void {
	const root = rootOf(runtime, ref.scope);
	assertProfilePartFits(ref, part, text);
	// The files are read with a single trailing newline removed, so writing it
	// back keeps the text a user typed in an editor verbatim.
	const content = text.endsWith("\n") ? text : `${text}\n`;
	const directory = profileDir(runtime, ref);
	// `profiles/` can itself be a link that leads out of the root, and `mkdir`
	// follows it. Checking the parent means nothing is created out there.
	if (
		!isRealPathInside(root, path.dirname(directory)) ||
		!isRealPathInside(root, directory)
	) {
		throw new Error(en.profiles.refusingOutsideRoot(root));
	}
	fs.mkdirSync(directory, { recursive: true });
	// Those checks are lexical while the directory does not exist yet. Now that it
	// exists the real filesystem can answer for its own path too.
	if (!isRealPathInside(root, directory)) {
		throw new Error(en.profiles.refusingOutsideRoot(root));
	}
	const file = path.join(directory, part === "prepend" ? PREPEND_FILE : APPEND_FILE);
	if (!isRealPathInside(root, file)) {
		throw new Error(en.profiles.refusingOutsideRoot(root));
	}
	atomicWriteFile(file, content);
}

/**
 * The existing id that differs from `ref.id` only in case, if there is one.
 *
 * Windows and macOS keep one directory for `Review` and `review`, so a second
 * profile would land on top of the first while the loader reports two entries.
 * The catalogue is keyed by the exact directory name, which is why this asks the
 * filesystem instead of the loaded profiles.
 */
function collidingId(runtime: Runtime, ref: ProfileRef): string | undefined {
	const directory = path.join(rootOf(runtime, ref.scope), "profiles");
	let entries: string[];
	try {
		entries = fs.readdirSync(directory);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
			// No `profiles/` directory yet: nothing can collide.
			return undefined;
		}
		// Any other failure means the check could not run, so the create stops
		// instead of writing a profile the filesystem may not tell apart.
		throw new Error(en.profiles.profilesUnreadable(directory, messageOf(cause)));
	}
	const wanted = ref.id.toLowerCase();
	return entries.find(
		(entry) => entry !== ref.id && entry.toLowerCase() === wanted,
	);
}

/**
 * Stops a create whose id collides with an existing profile ignoring case, and
 * one whose collision check could not run. `true` means the caller must stop.
 */
function refuseUnsafeCreate(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	ref: ProfileRef,
): boolean {
	let collision: string | undefined;
	try {
		collision = collidingId(runtime, ref);
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return true;
	}
	if (collision === undefined) {
		return false;
	}
	notify(ctx, en.profiles.caseCollision(ref.id, collision, ref.scope), "error");
	return true;
}

function handleNew(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): void {
	const id = args.positional[0];
	if (!id) {
		notify(ctx, en.command.usage, "warning");
		return;
	}
	if (!isSafeId(id)) {
		// Strict here: the directory is created with exactly the id given, so the
		// message states the rule and the id the same name would produce instead.
		notify(ctx, en.profiles.invalidNewId(id, suggestId(id)), "error");
		return;
	}
	const scopeFlag = parseScope(args.flags);
	if (rejectInvalidScope(ctx, scopeFlag)) {
		return;
	}
	const scope = scopeFlag.scope ?? "global";
	if (scope === "project" && !ctx.isProjectTrusted()) {
		notify(ctx, en.profiles.untrustedProject, "error");
		return;
	}
	const ref: ProfileRef = { scope, id };
	if (runtime.hasProfile(ref)) {
		notify(ctx, en.profiles.exists(formatRef(ref)), "warning");
		return;
	}
	if (refuseUnsafeCreate(runtime, ctx, ref)) {
		return;
	}
	const prepend = flagString(args.flags, "prepend");
	const append = flagString(args.flags, "append");
	const parts: Array<[ProfilePart, string]> = [];
	if (prepend !== undefined) {
		parts.push(["prepend", prepend]);
	}
	if (append !== undefined) {
		parts.push(["append", append]);
	}
	if (parts.length === 0) {
		notify(ctx, en.profiles.notWritten(id, profileDir(runtime, ref)), "warning");
		return;
	}
	try {
		// Every part is checked before either one is written: a refusal on the
		// second must not leave the first on disk while the notice says that
		// nothing was written.
		for (const [part, text] of parts) {
			assertProfilePartFits(ref, part, text);
		}
		for (const [part, text] of parts) {
			writeProfilePart(runtime, ref, part, text);
		}
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	reloadAfterWrite(runtime, ctx, undefined);
	notify(ctx, en.profiles.created(formatRef(ref), profileDir(runtime, ref)));
}

/**
 * Records the name a person typed as the profile's description. The files are
 * what make a profile; this is the text the lists show, and it is written only
 * when the name differs from the id.
 */
function writeProfileDescription(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	ref: ProfileRef,
	description: string,
): void {
	editConfig(runtime, ctx, ref.scope, (config) => {
		const current = config.profiles;
		const profiles =
			typeof current === "object" && current !== null && !Array.isArray(current)
				? (current as Record<string, unknown>)
				: {};
		const existing = profiles[ref.id];
		const meta =
			typeof existing === "object" &&
			existing !== null &&
			!Array.isArray(existing)
				? { ...(existing as Record<string, unknown>) }
				: {};
		meta.description = description;
		profiles[ref.id] = meta;
		config.profiles = profiles;
		return true;
	});
}

async function createProfileInteractive(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const name = (
		await ctx.ui.input(
			en.menu.createProfileTitle,
			en.menu.createProfilePlaceholder,
		)
	)?.trim();
	if (!name) {
		notify(ctx, en.profileCancelled);
		return;
	}
	// The dialog asks for a name. When the name is not already an id, the id is
	// derived from it and offered, and the name is kept as the description so a
	// person-readable title is not lost.
	let id = name;
	let description: string | undefined;
	if (!isSafeId(name)) {
		const suggested = suggestId(name);
		if (suggested === "") {
			notify(ctx, en.profiles.invalidIdRule(name), "error");
			return;
		}
		const accepted = await ctx.ui.confirm(
			en.profiles.suggestIdTitle,
			en.profiles.suggestIdBody(name, suggested),
		);
		if (!accepted) {
			notify(ctx, en.profileCancelled);
			return;
		}
		id = suggested;
		description = name;
	}
	const scope = await chooseScopeInteractive(ctx);
	if (!scope) {
		return;
	}
	const ref: ProfileRef = { scope, id };
	if (runtime.hasProfile(ref)) {
		notify(ctx, en.profiles.exists(formatRef(ref)), "warning");
		return;
	}
	if (refuseUnsafeCreate(runtime, ctx, ref)) {
		return;
	}
	const prepend = await ctx.ui.editor(
		`${en.menu.editPartPrepend} — ${formatRef(ref)}`,
		"",
	);
	if (prepend === undefined) {
		notify(ctx, en.profileCancelled);
		return;
	}
	const append = await ctx.ui.editor(
		`${en.menu.editPartAppend} — ${formatRef(ref)}`,
		"",
	);
	if (append === undefined) {
		notify(ctx, en.profileCancelled);
		return;
	}
	if (normalizeProfileText(prepend) === "" && normalizeProfileText(append) === "") {
		notify(ctx, en.profiles.emptyEdit(formatRef(ref)), "warning");
		return;
	}
	const parts: Array<[ProfilePart, string]> = [];
	if (normalizeProfileText(prepend) !== "") {
		parts.push(["prepend", prepend]);
	}
	if (normalizeProfileText(append) !== "") {
		parts.push(["append", append]);
	}
	try {
		// Same rule as the flag path: both editors' text is checked before anything
		// is written, the description included, so an oversized part leaves no
		// config.json entry behind either.
		for (const [part, text] of parts) {
			assertProfilePartFits(ref, part, text);
		}
		if (description !== undefined) {
			// The description goes before the files: a description whose profile has
			// no files yet is ignored by the loader, while files written before a
			// failed description would look complete and silently lose the name.
			writeProfileDescription(runtime, ctx, ref, description);
		}
		for (const [part, text] of parts) {
			writeProfilePart(runtime, ref, part, text);
		}
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	reloadAfterWrite(runtime, ctx, undefined);
	notify(
		ctx,
		en.profiles.created(formatRef(ref), profileDir(runtime, ref), description),
	);
}

async function editProfileInteractive(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	ref: ProfileRef,
): Promise<void> {
	const profile = profileOf(runtime, ref);
	if (!profile) {
		notify(ctx, en.profiles.notFound(formatRef(ref)), "error");
		return;
	}
	const partChoice = await selectItem(ctx, {
		title: en.menu.editPartTitle,
		items: [
			{ value: "prepend", label: en.menu.editPartPrepend },
			{ value: "append", label: en.menu.editPartAppend },
		],
	});
	const part: ProfilePart | undefined =
		partChoice === "prepend" || partChoice === "append" ? partChoice : undefined;
	if (!part) {
		return;
	}
	await editProfilePart(runtime, ctx, ref, part);
}

async function editProfilePart(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	ref: ProfileRef,
	part: ProfilePart,
): Promise<void> {
	const profile = profileOf(runtime, ref);
	if (!profile) {
		notify(ctx, en.profiles.notFound(formatRef(ref)), "error");
		return;
	}
	const file = path.join(profile.path, part === "prepend" ? PREPEND_FILE : APPEND_FILE);
	if (!ctx.hasUI) {
		notify(ctx, en.profiles.editNeedsTui(file), "error");
		return;
	}
	const current = part === "prepend" ? profile.prepend : profile.append;
	const other = part === "prepend" ? profile.append : profile.prepend;
	const updated = await ctx.ui.editor(
		`${part === "prepend" ? en.menu.editPartPrepend : en.menu.editPartAppend} — ${formatRef(ref)}`,
		current,
	);
	if (updated === undefined) {
		notify(ctx, en.profileCancelled);
		return;
	}
	// Clearing the only text would leave a profile the loader drops with a
	// profile-empty diagnostic.
	if (
		normalizeProfileText(updated) === "" &&
		normalizeProfileText(other) === ""
	) {
		notify(ctx, en.profiles.emptyEdit(formatRef(ref)), "warning");
		return;
	}
	try {
		writeProfilePart(runtime, ref, part, updated);
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	reloadAfterWrite(runtime, ctx, undefined);
	notify(
		ctx,
		en.profiles.saved(
			formatRef(ref),
			part === "prepend" ? PREPEND_FILE : APPEND_FILE,
		),
	);
}

async function handleEdit(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const input = args.positional[0];
	if (!input) {
		notify(ctx, en.command.usage, "warning");
		return;
	}
	const ref = findProfileRef(runtime, input);
	if (typeof ref === "string") {
		notify(ctx, ref, "error");
		return;
	}
	const profile = profileOf(runtime, ref);
	if (!profile) {
		notify(ctx, en.profiles.notFound(formatRef(ref)), "error");
		return;
	}
	const requested = flagString(args.flags, "part");
	if (requested !== undefined && requested !== "prepend" && requested !== "append") {
		notify(ctx, en.command.usage, "warning");
		return;
	}
	const part: ProfilePart =
		requested === "append" || requested === "prepend"
			? requested
			: partWithText(profile.prepend, profile.append);
	// Awaited: the write must finish before the command reports it done, or a
	// following read of the file sees the previous content.
	await editProfilePart(runtime, ctx, ref, part);
}

/** One `provider/model` rule line, `*` on the side the rule omits. */
function matchRules(binding: Binding): string {
	return binding.match
		.map((rule) => `${rule.provider ?? "*"}/${rule.model ?? "*"}`)
		.join(",");
}

function bindingList(runtime: Runtime): string[] {
	const lines: string[] = [];
	const scopes: Array<[Scope, Binding[] | undefined]> = [
		["project", runtime.configOf("project").config?.bindings],
		["global", runtime.configOf("global").config?.bindings],
	];
	for (const [scope, bindings] of scopes) {
		for (const binding of bindings ?? []) {
			const priority =
				binding.priority !== undefined && binding.priority !== 0
					? ` (priority ${binding.priority})`
					: "";
			lines.push(
				`${scope}:${binding.id} — ${binding.profile} ← ${matchRules(binding)}${priority}`,
			);
		}
	}
	return lines;
}

function availableModels(ctx: ExtensionCommandContext): ModelIdentity[] {
	return ctx.modelRegistry
		.getAvailable()
		.map((model) => ({ provider: String(model.provider), id: String(model.id) }));
}

async function chooseBindingTarget(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	ref: ProfileRef,
): Promise<{ provider: string; model: string } | undefined> {
	const models = availableModels(ctx);
	const subtitle = bindingContext(runtime, ctx, ref);
	const provider = await selectItem(ctx, {
		title: en.menu.bindProviderTitle(formatRef(ref)),
		subtitle,
		items: [
			{ value: "*", label: en.menu.bindAnyProvider },
			...providerNames(models).map((name) => ({ value: name, label: name })),
		],
	});
	if (provider === undefined) {
		return undefined;
	}
	if (provider === "*") {
		const target = await selectItem(ctx, {
			title: en.menu.bindAnyModelTitle,
			subtitle,
			items: [
				{ value: "*", label: en.menu.bindAnyModel },
				...allModels(models).map((entry) => ({
					// A model id can contain "/", so provider and id travel as JSON.
					value: JSON.stringify([entry.provider, entry.id]),
					label: `${entry.provider} · ${entry.id}`,
				})),
			],
		});
		if (target === undefined) {
			return undefined;
		}
		if (target === "*") {
			return { provider: "*", model: "*" };
		}
		const [targetProvider, targetModel] = JSON.parse(target) as [string, string];
		return { provider: targetProvider, model: targetModel };
	}
	const model = await selectItem(ctx, {
		title: en.menu.bindModelTitle(provider),
		subtitle,
		items: [
			{ value: "*", label: en.menu.bindAnyModelOf(provider) },
			...modelsOfProvider(models, provider).map((entry) => ({
				value: entry.id,
				label: entry.id,
			})),
		],
	});
	if (model === undefined) {
		return undefined;
	}
	return { provider, model };
}

/** One line describing the active model and the profile's current bindings. */
function bindingContext(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	ref: ProfileRef,
): string {
	const model = ctx.model;
	const current = model
		? `current model ${model.provider}/${model.id}`
		: "no model selected";
	const entries: string[] = [];
	const scopes: Array<[string, Binding[] | undefined]> = [
		["p", runtime.configOf("project").config?.bindings],
		["g", runtime.configOf("global").config?.bindings],
	];
	for (const [scope, bindings] of scopes) {
		for (const binding of bindings ?? []) {
			if (binding.profile !== formatRef(ref)) {
				continue;
			}
			entries.push(`${scope}:${matchRules(binding)}(p${binding.priority ?? 0})`);
		}
	}
	const existing = entries.length > 0 ? `bindings ${entries.join(" ")}` : "no bindings yet";
	return `${current} · ${existing}`;
}

/**
 * A binding can be saved correctly and still never fire: a pinned selection
 * bypasses matching, and a provider or model id that does not match fails
 * silently at resolution time. Report both right after the write.
 */
function reportBindingCaveats(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	binding: Binding,
): void {
	const status = runtime.getStatus();
	if (status.selection.mode !== "auto") {
		notify(
			ctx,
			en.bindings.cannotFire(selectionText(status.selection)),
			"warning",
		);
		return;
	}
	const active = ctx.model
		? { provider: String(ctx.model.provider), id: String(ctx.model.id) }
		: undefined;
	if (active && !binding.match.some((rule) => matchRule(rule, active))) {
		notify(ctx, en.bindings.doesNotMatch(`${active.provider}/${active.id}`), "warning");
	}
}

/** Drops every binding with this id and returns how many were removed. */
function removeBindingFrom(config: Record<string, unknown>, id: string): number {
	const current = config.bindings;
	if (!Array.isArray(current)) {
		return 0;
	}
	const filtered = current.filter(
		(entry) =>
			!(
				typeof entry === "object" &&
				entry !== null &&
				(entry as { id?: unknown }).id === id
			),
	);
	const removed = current.length - filtered.length;
	if (removed > 0) {
		config.bindings = filtered;
	}
	return removed;
}

async function handleBind(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const input = args.positional[0];
	if (!input) {
		notify(ctx, en.bindings.usage, "warning");
		return;
	}
	const ref = findProfileRef(runtime, input);
	if (typeof ref === "string") {
		notify(ctx, ref, "error");
		return;
	}
	const scopeFlag = parseScope(args.flags);
	if (rejectInvalidScope(ctx, scopeFlag)) {
		return;
	}
	const scope: Scope = scopeFlag.scope ?? ref.scope;

	let provider = flagString(args.flags, "provider") ?? "*";
	let model = flagString(args.flags, "model") ?? "*";
	if (
		flagString(args.flags, "provider") === undefined &&
		flagString(args.flags, "model") === undefined
	) {
		if (!ctx.hasUI) {
			notify(ctx, en.bindings.missingFlags, "error");
			return;
		}
		if (availableModels(ctx).length === 0) {
			notify(ctx, en.bindings.noModels, "error");
			return;
		}
		const target = await chooseBindingTarget(runtime, ctx, ref);
		if (!target) {
			notify(ctx, en.bindings.cancelled);
			return;
		}
		provider = target.provider;
		model = target.model;
	}

	const priority = flagNumber(args.flags, "priority") ?? 0;
	const wildcard = (value: string): string => (value === "*" ? "any" : value);
	const bindingId =
		flagString(args.flags, "id") ??
		`${ref.id}-${wildcard(provider)}-${wildcard(model)}`.replace(
			/[^A-Za-z0-9._-]/g,
			"-",
		);
	if (!isSafeId(bindingId)) {
		notify(ctx, en.bindings.invalidId(bindingId), "error");
		return;
	}
	const binding: Binding = {
		id: bindingId,
		profile: formatRef(ref),
		priority,
		match: [{ provider, model }],
	};
	try {
		editConfig(runtime, ctx, scope, (config) => {
			const existing = Array.isArray(config.bindings)
				? (config.bindings as unknown[])
				: [];
			const filtered = existing.filter(
				(entry) =>
					!(
						typeof entry === "object" &&
						entry !== null &&
						(entry as { id?: unknown }).id === bindingId
					),
			);
			config.bindings = [...filtered, binding];
			return true;
		});
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	reloadAfterWrite(runtime, ctx, undefined);
	notify(ctx, en.bindings.added(formatRef(ref), `${provider}/${model}`, priority, scope));
	reportBindingCaveats(runtime, ctx, binding);
}

async function handleUnbind(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const id = args.positional[0];
	if (!id) {
		notify(ctx, en.bindings.unbindUsage, "warning");
		return;
	}
	const scopeFlag = parseScope(args.flags);
	if (rejectInvalidScope(ctx, scopeFlag)) {
		return;
	}
	// Without --scope the binding can live in either config; only the implicit
	// search skips an untrusted project.
	const scopes: Scope[] = scopeFlag.scope ? [scopeFlag.scope] : ["project", "global"];
	let removed = 0;
	const removedFrom: Scope[] = [];
	try {
		for (const scope of scopes) {
			if (!scopeFlag.scope && scope === "project" && !ctx.isProjectTrusted()) {
				continue;
			}
			let removedHere = 0;
			editConfig(runtime, ctx, scope, (config) => {
				removedHere = removeBindingFrom(config, id);
				return removedHere > 0;
			});
			if (removedHere > 0) {
				removed += removedHere;
				removedFrom.push(scope);
			}
		}
	} catch (cause) {
		// A two-config pass can fail halfway. Report what already changed so a
		// plain repeat finishes the job instead of leaving a silent half state.
		const partial =
			removedFrom.length > 0
				? ` ${en.bindings.partial(removed, removedFrom.join(" and "), id)}`
				: "";
		runtime.reload();
		notify(ctx, `${messageOf(cause)}${partial}`, "error");
		return;
	}
	try {
		runtime.reload();
	} catch (cause) {
		notify(ctx, en.config.writtenNotReloaded(messageOf(cause)), "error");
		return;
	}
	notify(
		ctx,
		removed > 0
			? en.bindings.removed(removed, id, removedFrom.join(" and "))
			: scopeFlag.scope
				? en.bindings.notFoundInScope(id, scopeFlag.scope)
				: en.bindings.notFound(id),
	);
}

async function removeBindingInteractive(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const entries: Array<{ scope: Scope; binding: Binding }> = [];
	for (const binding of runtime.configOf("project").config?.bindings ?? []) {
		entries.push({ scope: "project", binding });
	}
	for (const binding of runtime.configOf("global").config?.bindings ?? []) {
		entries.push({ scope: "global", binding });
	}
	if (entries.length === 0) {
		notify(ctx, en.bindings.none);
		return;
	}
	const choice = await selectItem(ctx, {
		title: en.menu.removeBindingTitle,
		items: entries.map(({ scope, binding }) => ({
			value: JSON.stringify([scope, binding.id]),
			label: `${scope}:${binding.id} — ${binding.profile} ← ${matchRules(binding)}`,
		})),
	});
	if (choice === undefined) {
		return;
	}
	const [scope, id] = JSON.parse(choice) as [Scope, string];
	try {
		let removed = 0;
		editConfig(runtime, ctx, scope, (config) => {
			removed = removeBindingFrom(config, id);
			return removed > 0;
		});
		runtime.reload();
		notify(
			ctx,
			removed > 0
				? en.bindings.removed(removed, id, scope)
				: en.bindings.notFoundInScope(id, scope),
		);
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
	}
}

async function bindingsMenu(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	for (;;) {
		const choice = await selectItem(ctx, {
			title: en.menu.bindingsTitle,
			items: [
				{ value: "add", label: en.menu.bindingsAdd },
				{ value: "list", label: en.menu.bindingsList },
				{ value: "remove", label: en.menu.bindingsRemove },
				{ value: "back", label: en.menu.back },
			],
		});
		if (choice === undefined || choice === "back") {
			return;
		}
		if (choice === "list") {
			const lines = bindingList(runtime);
			notify(ctx, lines.length > 0 ? lines.join("\n") : en.bindings.none);
			continue;
		}
		if (choice === "remove") {
			await removeBindingInteractive(runtime, ctx);
			continue;
		}
		const entry = await pickProfileRef(runtime, ctx, en.menu.bindProfileTitle);
		if (entry) {
			await handleBind(runtime, ctx, {
				positional: [formatRef(entry.ref)],
				flags: {},
			});
		}
	}
}

function handleConfig(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	scope: Scope,
): void {
	if (scope === "project" && !ctx.isProjectTrusted()) {
		notify(ctx, en.config.untrustedProject, "warning");
		return;
	}
	const filePath = configRoot(runtime, scope);
	try {
		const snapshot = readRawConfig(filePath);
		const lines = [
			en.config.title(scope, filePath, snapshot.exists),
			JSON.stringify(snapshot.config, null, 2),
		];
		for (const key of settingKeys()) {
			const effective = effectiveSettingFor(runtime, key);
			lines.push(
				en.config.effective(
					key,
					JSON.stringify(effective.value),
					effective.origin,
				),
			);
		}
		const diagnostics: Diagnostic[] = runtime.configOf(scope).diagnostics;
		if (diagnostics.length > 0) {
			lines.push(formatDiagnostics(diagnostics));
		}
		notify(ctx, lines.join("\n"));
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
	}
}

/** Guards `/push config set|unset`, which write through the same path as `set`. */
function handleConfigWrite(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): void {
	const action = args.positional[0];
	const rest: ParsedArgs = {
		positional: args.positional.slice(1),
		flags: args.flags,
	};
	const scopeFlag = parseScope(args.flags);
	if (rejectInvalidScope(ctx, scopeFlag)) {
		return;
	}
	const scope: Scope = scopeFlag.scope ?? "global";
	if (action === "set") {
		const key = rest.positional[0];
		const value = rest.positional[1];
		if (!key || value === undefined || rest.positional.length > 2) {
			notify(ctx, en.command.usage, "warning");
			return;
		}
		setConfigSetting(runtime, ctx, key, value, scope);
		return;
	}
	const key = rest.positional[0];
	if (!key || rest.positional.length > 1) {
		notify(ctx, en.command.usage, "warning");
		return;
	}
	unsetConfigSetting(runtime, ctx, key, scope);
}

function unsetConfigSetting(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	rawKey: string,
	scope: Scope,
): void {
	let failure: string | undefined;
	try {
		const wrote = editConfig(runtime, ctx, scope, (config) => {
			const result = unsetSetting(config, rawKey);
			if (!result.ok) {
				failure = describeProblem(result.problem);
				return false;
			}
			return true;
		});
		if (!wrote) {
			notify(ctx, failure ?? en.config.noChange, "warning");
			return;
		}
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	const spec: SettingSpec | undefined = settingSpec(rawKey);
	notify(ctx, en.settings.removed(spec?.key ?? rawKey, scope));
	reloadAfterWrite(runtime, ctx, spec?.key);
}

function handleReload(runtime: Runtime, ctx: ExtensionCommandContext): void {
	try {
		runtime.attach(ctx);
		runtime.reload();
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	const errors = runtime.errorDiagnostics();
	notify(
		ctx,
		errors.length > 0
			? en.extension.configErrors(formatDiagnostics(errors))
			: en.reload.done,
		errors.length > 0 ? "error" : "info",
	);
}

/** The exact text the next message would receive, without sending anything. */
function handlePreview(runtime: Runtime, ctx: ExtensionCommandContext): void {
	const { resolution } = runtime.resolve();
	const profile = resolution.profile;
	if (!profile) {
		notify(ctx, en.preview.none, "warning");
		return;
	}
	const insertion = insertionOf(profile.layers);
	const { identity } = runtime.resolve();
	const lines = [
		en.preview.profile(formatRef(profile.ref), profile.layers.length),
		en.preview.model(
			identity ? `${identity.provider}/${identity.id}` : en.status.none,
		),
	];
	const side = (label: string, text: string): void => {
		lines.push(label);
		if (text === "") {
			lines.push(en.preview.empty);
			return;
		}
		lines.push(text.slice(0, PREVIEW_LIMIT));
		if (text.length > PREVIEW_LIMIT) {
			lines.push(en.preview.truncated(text.length - PREVIEW_LIMIT));
		}
	};
	side(en.preview.before(Buffer.byteLength(insertion.before, "utf8")), insertion.before);
	side(en.preview.after(Buffer.byteLength(insertion.after, "utf8")), insertion.after);
	lines.push(en.preview.safety);
	notify(ctx, lines.join("\n"), "warning");
}

/** The n-th most recent decorated send on the active branch. */
function handleShow(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	index: number,
): void {
	const views = runtime.listApplied(Number.MAX_SAFE_INTEGER);
	if (views.length === 0) {
		notify(ctx, en.show.none, "warning");
		return;
	}
	const position = views.length - index;
	const view = position >= 0 ? views[position] : undefined;
	if (!view) {
		notify(ctx, en.show.outOfRange(index, views.length), "error");
		return;
	}
	const lines = [
		en.show.title(index, views.length, view.entry.profile, view.entry.mode),
	];
	if (!view.intact || view.original === undefined) {
		lines.push(en.show.modified);
		lines.push(en.show.effective, view.effective);
	} else {
		lines.push(en.show.original, view.original);
		lines.push(en.show.effective, view.effective);
	}
	notify(ctx, lines.join("\n"));
}

function handleShowArgs(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): void {
	const raw = args.positional[0];
	if (raw === undefined) {
		handleShow(runtime, ctx, 1);
		return;
	}
	const index = Number(raw);
	if (!Number.isInteger(index) || index < 1) {
		notify(ctx, en.show.invalid(raw), "error");
		return;
	}
	handleShow(runtime, ctx, index);
}

/**
 * Reads the three flags and applies the one that was given. More than one is a
 * contradiction, so nothing is applied and the user is told why.
 */
function applyFlags(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ExtensionContext,
): void {
	const profile = pi.getFlag(FLAG_PROFILE);
	const auto = pi.getFlag(FLAG_AUTO) === true;
	const off = pi.getFlag(FLAG_OFF) === true;
	const named = typeof profile === "string" && profile !== "";
	const asked = (named ? 1 : 0) + (auto ? 1 : 0) + (off ? 1 : 0);
	if (asked === 0) {
		return;
	}
	if (asked > 1) {
		notify(ctx, en.flags.conflict, "error");
		return;
	}
	if (off) {
		runtime.applyFlagSelection({ mode: "off" });
		return;
	}
	if (auto) {
		runtime.applyFlagSelection({ mode: "auto" });
		return;
	}
	const value = String(profile);
	const ref = resolveRef(value, "global");
	if (!ref) {
		notify(ctx, en.flags.invalidRef(value), "error");
		return;
	}
	if (!runtime.hasProfile(ref)) {
		notify(ctx, en.flags.missingProfile(value), "error");
		return;
	}
	runtime.applyFlagSelection({ mode: "manual", profile: formatRef(ref) });
}

export function registerPushCommands(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerFlag(FLAG_PROFILE, {
		description: en.flags.profile,
		type: "string",
	});
	pi.registerFlag(FLAG_AUTO, { description: en.flags.auto, type: "boolean" });
	pi.registerFlag(FLAG_OFF, { description: en.flags.off, type: "boolean" });

	pi.on("session_start", (_event, ctx) => {
		runtime.attach(ctx);
		try {
			runtime.ensure(ctx);
			applyFlags(pi, runtime, ctx);
		} catch (cause) {
			ctx.ui.notify(`${en.extension.prefix}: ${messageOf(cause)}`, "error");
		}
	});

	pi.registerCommand(COMMAND_NAME, {
		description: en.command.description,
		getArgumentCompletions(argumentPrefix: string) {
			const parts = argumentPrefix.split(/\s+/);
			if (parts.length <= 1) {
				return en.command.subcommands
					.filter((name) => name.startsWith(parts[0] ?? ""))
					.map((name) => ({ value: name, label: name }));
			}
			const first = parts[0];
			if (
				first === "use" ||
				first === "edit" ||
				first === "bind" ||
				first === "default" ||
				first === "once"
			) {
				return listProfileLines(runtime, undefined).map((line) => {
					const value = line.split(" —")[0] ?? line;
					return { value: `${first} ${value}`, label: value };
				});
			}
			return null;
		},
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			try {
				runtime.attach(ctx);
				// No eager load here: a command that needs the config asks for it, so
				// `/push off`, `/push auto` and `/push help` still work when a file
				// cannot be read and every send is being stopped.
				const parsed = parseArgs(args);
				const subcommand = parsed.positional[0] ?? "menu";
				const operands: ParsedArgs = {
					positional: parsed.positional.slice(1),
					flags: parsed.flags,
				};
				switch (subcommand) {
					case "menu":
						if (ctx.hasUI) {
							await interactiveMenu(runtime, ctx);
						} else {
							notify(ctx, en.command.usage);
						}
						return;
					case "help":
						notify(ctx, en.help.join("\n"));
						return;
					case "list":
						handleList(runtime, ctx, operands);
						return;
					case "use":
						handleUse(runtime, ctx, operands);
						return;
					case "auto":
						runtime.setSelection({ mode: "auto" });
						notify(ctx, en.selection.auto);
						return;
					case "off":
						runtime.setSelection({ mode: "off" });
						notify(ctx, en.selection.off);
						return;
					case "once":
						handleOnce(runtime, ctx, operands);
						return;
					case "status":
						notify(ctx, statusText(runtime, ctx));
						return;
					case "why":
						notify(ctx, whyText(runtime, ctx));
						return;
					case "preview":
						handlePreview(runtime, ctx);
						return;
					case "show":
						handleShowArgs(runtime, ctx, operands);
						return;
					case "validate":
						notify(ctx, validateText(runtime, ctx));
						return;
					case "reload":
						handleReload(runtime, ctx);
						return;
					case "new":
						handleNew(runtime, ctx, operands);
						return;
					case "edit":
						await handleEdit(runtime, ctx, operands);
						return;
					case "default":
						handleDefault(runtime, ctx, operands);
						return;
					case "bind":
						await handleBind(runtime, ctx, operands);
						return;
					case "unbind":
						await handleUnbind(runtime, ctx, operands);
						return;
					case "config": {
						const action = operands.positional[0];
						if (action === "set" || action === "unset") {
							handleConfigWrite(runtime, ctx, operands);
							return;
						}
						const scopeFlag = parseScope(operands.flags);
						if (rejectInvalidScope(ctx, scopeFlag)) {
							return;
						}
						handleConfig(runtime, ctx, scopeFlag.scope ?? "global");
						return;
					}
					case "set": {
						const key = operands.positional[0];
						const value = operands.positional[1];
						const scopeFlag = parseScope(operands.flags);
						if (rejectInvalidScope(ctx, scopeFlag)) {
							return;
						}
						if (!key || value === undefined || operands.positional.length > 2) {
							notify(ctx, en.command.usage, "warning");
							return;
						}
						setConfigSetting(runtime, ctx, key, value, scopeFlag.scope ?? "global");
						return;
					}
					case "unset": {
						const key = operands.positional[0];
						const scopeFlag = parseScope(operands.flags);
						if (rejectInvalidScope(ctx, scopeFlag)) {
							return;
						}
						if (!key || operands.positional.length > 1) {
							notify(ctx, en.command.usage, "warning");
							return;
						}
						unsetConfigSetting(runtime, ctx, key, scopeFlag.scope ?? "global");
						return;
					}
					default:
						notify(ctx, en.command.unknownSubcommand(subcommand), "error");
				}
			} catch (cause) {
				notify(ctx, `${en.extension.prefix}: ${messageOf(cause)}`, "error");
			}
		},
	});
}
