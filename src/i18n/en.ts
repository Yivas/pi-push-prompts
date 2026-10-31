/**
 * Every string a person reads in Push Prompts, in English.
 *
 * The command surface, the picker, the status reports and the adapter notices
 * take their wording here so nobody has to grep the logic to find a sentence.
 * Values are plain strings, or functions when a sentence needs a value; a
 * function keeps the argument order with the sentence instead of a placeholder
 * a translator can silently break.
 *
 * Nothing in this file may be inserted into a message: these texts are for
 * people, not for the model.
 */

import type { DisplayMode, Scope } from "../core/types.ts";
import type { SettingKey } from "../core/settings.ts";

/** How a scope is named after a sentence, when the scope word starts it. */
function scopeName(scope: Scope): string {
	return scope === "project" ? "the project config" : "the global config";
}

function scopeLabel(scope: Scope): string {
	return scope === "project" ? "Project (this repository)" : "Global (all projects)";
}

/** How a scope is named after an id, which lives in a scope and not in a file. */
function scopeWord(scope: Scope): string {
	return scope === "project" ? "the project scope" : "the global scope";
}

/** Short scope name, for a menu row whose value is a scope. */
function menuScopeName(scope: Scope): string {
	return scope === "project" ? "Project" : "Global";
}

/**
 * The id rule in the words a person reads. Ids become directory names, so the
 * rule is not cosmetic; it is written once here so every message states it the
 * same way.
 */
const ID_RULE =
	"An id uses letters, digits, dot, dash and underscore, starts with a letter or digit, and is at most 64 characters long.";

export const en = {
	/** Shown when the user backs out of a dialog without a change. */
	profileCancelled: "Cancelled. Nothing was written.",
	extension: {
		/** Prefix of every notice this extension raises. */
		prefix: "push-prompts",
		failed: (reason: string) => `push-prompts: ${reason}`,
		blockedRestore:
			"Nothing was sent; the text is back in the editor. Fix the problem and send again.",
		blockedKeep: "Nothing was sent. Fix the problem and send again.",
		/** Names the diagnostic that stopped a send, so /push validate can be matched to it. */
		blockedBy: (code: string, message: string) => `[${code}] ${message}`,
		checkFailed: (reason: string) =>
			`the profile check could not run (${reason}).`,
		sentUnchanged: "The message was sent unchanged.",
		decorateFailed: (reason: string) =>
			`push-prompts: ${reason}; the message was sent without the profile.`,
		configErrors: (lines: string) => `push-prompts:\n${lines}`,
		entryTitle: (profile: string, mode: string) =>
			`push-prompts: ${profile} (${mode})`,
		entryBefore: "added before:",
		entryAfter: "added after:",
	},
	command: {
		description:
			"Manage Push Prompts profiles: menu, use, auto, off, once, list, new, edit, default, bind, unbind, config, set, unset, status, why, preview, show, validate, reload, help.",
		usage:
			"Usage: /push <menu | use <profile> | auto | off | once <profile> | once off | list | new <id> | edit <profile> | default <profile> | bind <profile> | unbind <id> | config | set <key> <value> | unset <key> | status | why | preview | show [n] | validate | reload | help>",
		unknownSubcommand: (name: string) =>
			`Unknown subcommand "${name}". Run /push help.`,
		subcommands: [
			"menu",
			"use",
			"auto",
			"off",
			"once",
			"list",
			"new",
			"edit",
			"default",
			"bind",
			"unbind",
			"config",
			"set",
			"unset",
			"status",
			"why",
			"preview",
			"show",
			"validate",
			"reload",
			"help",
		],
	},
	help: [
		"/push                        menu of the common actions",
		"/push use <profile>          pin a profile for this session",
		"/push auto                   resolve from bindings and defaults",
		"/push off                    stop adding text for this session",
		"/push once <profile>         use this profile for the next message only",
		"/push once off               cancel the profile armed for the next message",
		"/push list [--scope ...]     list profiles",
		"/push new <id>               create a profile; --prepend/--append write it",
		"/push edit <profile>         edit a profile part",
		"/push default <profile>      set defaultProfile",
		"/push bind <profile>         bind a profile to a provider/model",
		"/push unbind <id>            remove a binding",
		"/push config [--scope ...]   show a config file, or set/unset inside it",
		"/push set <key> <value>      change a setting",
		"/push unset <key>            remove a setting",
		"/push status                 show what applies now",
		"/push why                    explain why a profile does or does not apply",
		"/push preview                show the exact text the next message would get",
		"/push show [n]               show the original and the effective text of a send",
		"/push validate               report configuration problems",
		"/push reload                 re-read configuration and profiles from disk",
		"Flags: --push-profile <ref>, --push-auto, --push-off.",
		"Settings: selection, display, subagents, inheritGlobalBindings.",
	],
	flags: {
		profile:
			"Pin a Push Prompts profile for this run (bare id, global:id or project:id).",
		auto: "Resolve the Push Prompts profile from bindings and defaults for this run.",
		off: "Stop Push Prompts from adding text for this run.",
		conflict:
			"push-prompts: --push-profile, --push-auto and --push-off cannot be combined. None of them was applied.",
		invalidRef: (value: string) =>
			`push-prompts: --push-profile "${value}" is not a valid profile reference (use an id, global:id or project:id). None was applied.`,
		missingProfile: (value: string) =>
			`push-prompts: --push-profile "${value}" was not found. None was applied.`,
	},
	picker: {
		search: "Search: ",
		searchHint: "type to filter",
		noMatches: "  No matches",
		counter: (start: number, end: number, total: number) =>
			`  ${start}-${end} of ${total}`,
		hint: "↑↓ navigate · enter select · esc cancel",
		previousPage: "← Previous page",
		more: "More…",
	},
	menu: {
		/** Main title: what applies now, and what is armed for the next message. */
		title: {
			main: (active: string, next: string) =>
				`Push · Active: ${active} · Next: ${next}`,
			active: (profile: string, origin: string) => `${profile} (${origin})`,
			profiles: "Push · Profiles",
			profile: (ref: string) => `Push · ${ref}`,
			bindings: "Push · Model bindings",
			settings: "Push · Settings",
			inspect: "Push · Check and inspect",
		},
		/** Why the profile named in the title applies. */
		origin: {
			session: "session",
			auto: "auto",
			default: "default",
		},
		none: "none",
		off: "off",
		/** Marks the value, profile or scope already in force. */
		current: " (current)",
		useSession: "Use a profile for this session…",
		nextMessage: (profile: string) => `Next message: ${profile}…`,
		profilesSection: "Profiles…",
		bindingsSection: "Model bindings…",
		settingsSection: "Settings…",
		inspectSection: "Check and inspect…",
		help: "Help",
		back: "Back",
		browseProfiles: "Browse profiles…",
		/** The dialog title carries the rule: Pi 1.4.0 does not render a placeholder. */
		createProfileTitle:
			"Name the new profile. Its id allows letters, digits, dot, dash and underscore, starts with a letter or digit, and is at most 64 characters.",
		createProfilePlaceholder: "for example: code review",
		createProfile: "Create a profile…",
		editProfile: "Edit a profile…",
		showProfileText: "Show text",
		editProfilePart: "Edit",
		useForSession: "Use for this session",
		setAsDefault: "Set as default",
		profilePickerTitle: "Which profile?",
		sessionProfileTitle: "Which profile for this session?",
		nextMessageTitle: "Which profile for the next message?",
		automatic: "Automatic (follow model bindings)",
		offOption: "Off for this session",
		cancelNext: "Cancel: add nothing to the next message",
		bindCurrent: (model: string) => `Bind ${model} to a profile…`,
		bindProfile: "Bind a profile to a model…",
		removeBinding: "Remove a binding…",
		listBindings: "Show all bindings",
		/** The row that picks the config every write from the menu goes to. */
		scopeRow: (name: string) => `Save changes to: ${name}…`,
		scopeName: menuScopeName,
		scopeStored: (scope: Scope) =>
			`The menu now writes to ${menuScopeName(scope)}.`,
		scopeTitle: "Which configuration?",
		settingNames: {
			selection: "Selection",
			defaultProfile: "Default profile",
			subagents: "Subagents",
			display: "Added text",
			inheritGlobalBindings: "Inherit global bindings",
		} satisfies Record<SettingKey, string>,
		settingRow: (name: string, value: string, inherited = false) =>
			`${name}: ${value}${inherited ? " (from global)" : ""}`,
		settingValueTitle: (name: string, scope: Scope) =>
			`${name} in ${scopeName(scope)}`,
		settingValue: (key: SettingKey, value: string) =>
			key === "inheritGlobalBindings" ? (value === "true" ? "yes" : "no") : value,
		useGlobalValue: (value: string) => `Use global value (${value})`,
		noDefault: "None (no default profile)",
		status: "Status",
		why: "Why this profile?",
		preview: "Preview next message",
		showLast: "Last added text",
		config: "Show configuration",
		validate: "Check configuration",
		reload: "Reload from disk",
		editProfileTitle: "Which profile do you want to edit?",
		editPartTitle: "Which part of the profile?",
		editPartPrepend: "Before the message (prepend.md)",
		editPartAppend: "After the message (append.md)",
		defaultProfileTitle: "Which profile is the default?",
		bindProfileTitle: "Which profile do you want to bind?",
		bindProviderTitle: (profile: string) =>
			`Bind ${profile}: which provider?`,
		bindModelTitle: (provider: string) => `Bind: which model of ${provider}?`,
		bindAnyModelTitle: "Bind: which model of any provider?",
		bindAnyProvider: "(any provider)",
		bindAnyModel: "(any model)",
		bindAnyModelOf: (provider: string) => `(any model of ${provider})`,
		removeBindingTitle: "Which binding do you want to remove?",
	},
	settings: {
		unknownKey: (input: string, known: string) =>
			`Unknown setting "${input}". Known: ${known}.`,
		needsOwnCommand: (key: string) =>
			`${key} is written by its own command, not by "/push set"; "/push unset ${key}" removes it.`,
		invalidValue: (key: string, values: string) =>
			`${key} must be one of: ${values}.`,
		booleanValue: (key: string) => `${key} must be true or false.`,
		projectOnly: (key: string) =>
			`${key} only applies to the project config; pass --scope project.`,
		notSet: (key: string) => `${key} is not set in this config.`,
		set: (key: string, value: string, scope: Scope) =>
			`${key} set to ${value} in ${scopeName(scope)}.`,
		removed: (key: string, scope: Scope) =>
			`${key} removed from ${scopeName(scope)}.`,
		droppedManual: "The previous selection.profile was dropped.",
		sessionKeepsSelection:
			"This session keeps its own selection; the stored value applies to new sessions.",
		subagentsTakeEffect:
			"Subagents that start from now on use the new policy.",
	},
	profiles: {
		none: "No profiles found. Create one first.",
		notFound: (ref: string) => `Profile ${ref} was not found.`,
		/** What "Show text" prints: both files as they are stored. */
		textTitle: (ref: string) => `Text of ${ref}:`,
		textPart: (file: string, bytes: number) => `${file} (${bytes} bytes):`,
		invalidId: (id: string) => `"${id}" is not a valid profile id.`,
		invalidNewId: (id: string, suggestion: string) =>
			`"${id}" is not a valid profile id. ${ID_RULE}${
				suggestion === "" ? "" : ` Try /push new ${suggestion}.`
			}`,
		/** Shown when the typed name cannot become an id at all. */
		invalidIdRule: (name: string) =>
			`"${name}" cannot become a profile id. ${ID_RULE}`,
		suggestIdTitle: "Use a suggested id?",
		suggestIdBody: (name: string, id: string) =>
			`"${name}" cannot be used as an id. Use "${id}"?`,
		noneInScope: "No profiles found.",
		created: (ref: string, directory: string, description?: string) =>
			description === undefined
				? `Created ${ref} at ${directory}.`
				: `Created ${ref} at ${directory}, with "${description}" as its description.`,
		/** A new id that differs only in case from a profile that already exists. */
		caseCollision: (id: string, existing: string, scope: Scope) =>
			`"${id}" differs only in case from the existing profile ${existing} in ${scopeWord(scope)}. Use another id.`,
		profilesUnreadable: (directory: string, reason: string) =>
			`Cannot create a profile: ${directory} could not be read (${reason}). Nothing was written.`,
		notWritten: (id: string, directory: string) =>
			`Nothing was written for ${id}. Add --prepend <text> or --append <text> to /push new, or use "Create a profile" in the menu; the files would go in ${directory}.`,
		exists: (ref: string) => `${ref} already exists. Use /push edit.`,
		saved: (ref: string, part: string) => `Saved ${part} of ${ref}.`,
		emptyEdit: (ref: string) =>
			`Nothing was written: ${ref} needs text in prepend.md or append.md.`,
		editNeedsTui: (path: string) =>
			`Editing needs the interactive UI. Open ${path} with your editor.`,
		refusingOutsideRoot: (root: string) =>
			`Refusing to write outside ${root}.`,
		tooLarge: (ref: string, part: string, maxBytes: number) =>
			`Nothing was written: ${part}.md of ${ref} would exceed ${maxBytes} bytes, the limit the loader applies.`,
		untrustedProject:
			"This project is not trusted, so its profiles are not read or written.",
		defaultSet: (ref: string, scope: Scope) =>
			`defaultProfile set to ${ref} in ${scopeName(scope)}.`,
		defaultMissing: (ref: string) =>
			`Profile ${ref} was not found; defaultProfile was not changed.`,
	},
	selection: {
		auto: "Selection: auto.",
		off: "Selection: off.",
		manual: (ref: string) => `Selection: ${ref}.`,
		onceArmed: (ref: string) =>
			`${ref} applies to the next message only. Nothing else changes.`,
		onceNone: "No profile was armed for the next message.",
		onceCancelled: "The profile armed for the next message was cancelled.",
	},
	status: {
		title: "Push Prompts",
		selection: (mode: string) => `selection: ${mode}`,
		origin: (origin: string) => `origin: ${origin}`,
		once: (ref: string) => `next message only: ${ref}`,
		model: (model: string) => `model: ${model}`,
		none: "none",
		resolved: (ref: string) => `profile: ${ref}`,
		resolvedNone: "profile: none (the message is sent as written)",
		binding: (ref: string) => `binding: ${ref}`,
		layers: (refs: string) => `layers: ${refs}`,
		display: (mode: DisplayMode) => `added text: ${mode}`,
		trust: (trusted: boolean) =>
			`project config: ${trusted ? "read (trusted)" : "not read (untrusted)"}`,
		diagnostics: (count: number) => `diagnostics: ${count}`,
	},
	why: {
		off: "Push Prompts is off for this session, so no profile is applied.",
		manual: (ref: string) =>
			`The session selection ${ref} is applied to every new message.`,
		binding: (id: string, scope: string, ref: string) =>
			`Binding ${id} (${scope}) gives ${ref} to this model.`,
		defaultProfile: (ref: string) =>
			`No binding matched, so the default profile ${ref} applies.`,
		none: (model: string) =>
			`No binding and no default profile apply to ${model}; the message is sent as written.`,
		ignored: (rules: string) => `rules considered but not applied: ${rules}`,
		noModel: "No model is selected yet; the profile is resolved on the next send.",
	},
	preview: {
		profile: (ref: string, layers: number) =>
			`profile: ${ref} (${layers} layer${layers === 1 ? "" : "s"})`,
		model: (model: string) => `model: ${model}`,
		before: (bytes: number) => `added before the message (${bytes} bytes):`,
		after: (bytes: number) => `added after the message (${bytes} bytes):`,
		empty: "(nothing)",
		none: "No profile applies to this model, so nothing would be added.",
		safety:
			"This is a preview. Nothing is sent and no message is recorded. It may show private profile text.",
		truncated: (rest: number) => `... (${rest} more characters)`,
	},
	show: {
		invalid: (value: string) => `"${value}" is not a message number.`,
		none: "No decorated message is recorded on this branch.",
		outOfRange: (index: number, count: number) =>
			`There is no decorated message ${index} on this branch; the branch holds ${count}.`,
		title: (index: number, total: number, ref: string, mode: string) =>
			`Message ${index} of ${total} most recent (${ref}, ${mode}):`,
		original: "original:",
		effective: "effective (what was sent):",
		modified:
			"Another writer changed this message after Push Prompts recorded it, so the original cannot be recovered.",
	},
	validate: {
		title: "Push Prompts configuration",
		globalConfig: (state: string) => `global config: ${state}`,
		projectConfig: (state: string) => `project config: ${state}`,
		present: "present",
		absent: "absent",
		notRead: "not read (project untrusted)",
		trust: (trusted: boolean) => `project trusted: ${trusted ? "yes" : "no"}`,
		globalProfiles: (count: number) => `global profiles: ${count}`,
		projectProfiles: (count: number) => `project profiles: ${count}`,
		resolved: (ref: string) => `profile for this model: ${ref}`,
		resolvedNone: "profile for this model: none",
		diagnostics: (count: number) => `diagnostics: ${count}`,
		clean: "No problems found.",
	},
	config: {
		title: (scope: Scope, path: string, exists: boolean) =>
			exists
				? `${scope} config (${path}):`
				: `${scope} config (no file at ${path}; defaults apply):`,
		effective: (key: string, value: string, origin: string) =>
			`${key} = ${value} (from ${origin})`,
		noChange: "Nothing was written.",
		untrustedProject:
			"The project is not trusted, so its configuration is not read.",
		writtenNotReloaded: (reason: string) =>
			`Written, but the reload failed: ${reason}. Run /push reload.`,
		stillBroken: (lines: string) =>
			`Written, but the configuration still has errors (they may predate this change):\n${lines}\nRun /push reload.`,
	},
	bindings: {
		none: 'No bindings configured. Use "Add a binding to a model" to create one.',
		usage:
			"Usage: /push bind <profile> [--provider <p>] [--model <m>] [--scope global|project] [--priority <n>] [--id <id>]",
		unbindUsage: "Usage: /push unbind <id> [--scope global|project]",
		missingFlags:
			"Pass --provider and/or --model, or run the command in the interactive UI.",
		noCurrentModel:
			"No model is selected yet, so there is no model to bind.",
		noModels: "No models are available to bind.",
		invalidId: (id: string) => `Binding id "${id}" is not a valid id; pass --id.`,
		added: (ref: string, target: string, priority: number, scope: Scope) =>
			`Bound ${ref} to ${target} (priority ${priority}) in ${scopeName(scope)}.`,
		cannotFire: (selection: string) =>
			`Selection is "${selection}" and bindings apply only in auto mode; run /push auto to use this binding.`,
		doesNotMatch: (model: string) =>
			`This binding does not match the current model ${model}.`,
		removed: (count: number, id: string, scopes: string) =>
			`Removed ${count} binding(s) named "${id}" from ${scopes}.`,
		notFound: (id: string) => `No binding named "${id}" was found.`,
		notFoundInScope: (id: string, scope: Scope) =>
			`No binding named "${id}" was found in ${scopeName(scope)}.`,
		partial: (removed: number, scopes: string, id: string) =>
			`Removed ${removed} from ${scopes} first; run /push unbind ${id} again to finish.`,
		cancelled: "Cancelled. No binding was written.",
	},
	args: {
		invalidScope: (value: string) =>
			`Invalid --scope "${value}". Use global or project.`,
		missingScope: "Missing value for --scope. Use global or project.",
		scope: (scope: Scope) => scopeLabel(scope),
	},
	reload: {
		done: "Reloaded configuration and profiles from disk.",
	},
	display: {
		set: (mode: DisplayMode, scope: Scope) =>
			`Show added text: ${mode}, stored in ${scopeName(scope)}.`,
	},
} as const;
