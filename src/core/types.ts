/**
 * Shared domain types for the push-prompts core.
 *
 * Derived from pi-prompt-profiles src/core/types.ts at 3f6d583 (MIT).
 *
 * The core has no Pi runtime import so it can be unit tested in isolation; the
 * Pi adapter converts its own types into these.
 */

export type Scope = "global" | "project";

/** A profile identified by scope and local id, e.g. `global:base`. */
export interface ProfileRef {
	scope: Scope;
	id: string;
}

export type SelectionConfig =
	| { mode: "auto" }
	| { mode: "manual"; profile: string }
	| { mode: "off" };

/** How a profile applies inside a subagent run. */
export const SUBAGENT_POLICIES = ["off", "bindings", "inherit"] as const;
export type SubagentPolicy = (typeof SUBAGENT_POLICIES)[number];

/** Selection modes accepted in `config.json`. */
export const SELECTION_MODES = ["auto", "off", "manual"] as const;

/**
 * How the Push row presents decorated messages. It only changes what the TUI
 * paints: the stored message and the request always carry the full text.
 */
export const DISPLAY_MODES = ["hidden", "added"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];
export const DEFAULT_DISPLAY: DisplayMode = "hidden";

/** Optional metadata for a profile, stored in `config.json`. */
export interface ProfileMeta {
	/** Single optional parent profile. Bare ids resolve inside the same scope. */
	extends?: string;
	description?: string;
}

/** One provider/model rule. Absent fields behave as `*`. */
export interface MatchRule {
	provider?: string;
	model?: string;
}

export interface Binding {
	id: string;
	profile: string;
	/** Higher wins. Missing means 0. */
	priority?: number;
	/** Rules are OR-ed; provider and model inside a rule are AND-ed. */
	match: MatchRule[];
}

/** Versioned configuration file. Only version 1 exists today. */
export interface ConfigV1 {
	version: 1;
	selection?: SelectionConfig;
	defaultProfile?: string;
	profiles?: Record<string, ProfileMeta>;
	bindings?: Binding[];
	/** Project-only. `false` disables global bindings for this project. */
	inheritGlobalBindings?: boolean;
	/**
	 * Applies in subagents. `bindings` only uses an explicit binding for the
	 * child's model, `inherit` resolves normally and `off` applies nothing.
	 */
	subagents?: SubagentPolicy;
	/** Presentation only. Missing means `hidden`. */
	display?: DisplayMode;
}

/**
 * One profile, read from `profiles/<id>/`. Both text files are optional, but
 * at least one of them must hold text. The text is kept as read apart from a
 * leading BOM; decoration normalizes line endings and the trailing newline.
 */
export interface LoadedProfile {
	id: string;
	scope: Scope;
	/** Profile directory, not a file. */
	path: string;
	/** Empty string when the file is absent. */
	prepend: string;
	append: string;
	description?: string;
}

export interface ProfileLayer {
	ref: ProfileRef;
	prepend: string;
	append: string;
}

export interface ResolvedProfile {
	ref: ProfileRef;
	/** Specific profile first, then its bases in inheritance order. */
	layers: ProfileLayer[];
}

export type DiagnosticLevel = "info" | "warn" | "error";

export interface Diagnostic {
	level: DiagnosticLevel;
	code: string;
	message: string;
}

/** A parsed config file with validation results. */
export interface SourceConfig {
	scope: Scope;
	path: string;
	exists: boolean;
	config: ConfigV1 | undefined;
	diagnostics: Diagnostic[];
}

export interface BindingMatch {
	binding: Binding;
	scope: Scope;
	rule: MatchRule;
	/** 0 = both wildcards, 3 = both exact. */
	specificity: number;
}

export interface Selection {
	mode: "auto" | "manual" | "off";
	/** Normalized reference when the mode is manual. */
	profile?: string;
}

export interface ModelIdentity {
	provider: string;
	id: string;
}

export interface Resolution {
	mode: "native" | "auto" | "manual" | "off";
	profile?: ResolvedProfile;
	binding?: BindingMatch;
	/** Matching rules that were considered but did not win. */
	ignored: BindingMatch[];
	diagnostics: Diagnostic[];
}

export interface ProfileCatalog {
	scope: Scope;
	profiles: Map<string, LoadedProfile>;
	createDiagnostics: Diagnostic[];
}

/**
 * The subset of a Pi content block this core reads. Other fields, including
 * images and any provider-specific block, are passed through untouched.
 */
export interface ContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	[key: string]: unknown;
}

/** User message content as Pi delivers it: either plain text or blocks. */
export type UserContent = string | readonly ContentBlock[];

/**
 * Where inserted text landed on one side of an array message: merged into the
 * existing text block at that end, or carried by a new text block.
 */
export type DecorationPlacement = "merged" | "new-block";

export interface DecorationShape {
	content: "string" | "array";
	prefix?: DecorationPlacement;
	suffix?: DecorationPlacement;
}

export interface Decoration {
	content: UserContent;
	/**
	 * Exact text added at the start, separator included: `prepend + "\n\n"`
	 * when there is a prepend, otherwise the empty string.
	 */
	insertedPrefix: string;
	/** Exact text added at the end, separator included: `"\n\n" + append`. */
	insertedSuffix: string;
	shape: DecorationShape;
}

/** Data of a `push-prompts.applied` session entry. */
export interface AppliedEntry {
	schema: 1;
	/** Normalized `scope:id` reference of the applied profile. */
	profile: string;
	mode: "active" | "once";
	insertedPrefix: string;
	insertedSuffix: string;
	shape: DecorationShape;
	timestamp: number;
	role: "user";
	provider: string;
	model: string;
	originalDigest: string;
	effectiveDigest: string;
}
