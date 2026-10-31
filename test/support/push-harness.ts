/**
 * Harness for the production extension: a public Pi SDK session with the real
 * provider adapters, the real extension factory, and a simulated outbound
 * transport. The only stand-in is the network boundary.
 *
 * Assertions compare the serialized request bodies the adapters send. A failure
 * reports digests, lengths and the first differing index, never a body.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	AgentSession,
	CompactionSettings,
	ExtensionUIContext,
	InlineExtension,
	ModelRuntime,
	RetrySettings,
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { APPLIED_ENTRY_TYPE, parseAppliedEntry } from "../../src/core/applied.ts";
import type { AppliedEntry } from "../../src/core/types.ts";
import { createPushPromptsExtension, type Runtime } from "../../src/index.ts";
import { STATE_ENTRY_TYPE } from "../../src/adapter/state.ts";
import {
	createHarnessSession,
	createSandbox,
	createSyntheticRuntime,
	type HarnessSession,
	type Sandbox,
} from "./isolated-session.ts";
import {
	installSyntheticTransport,
	SYNTHETIC_REPLY_TEXT,
	type SyntheticProvider,
	type SyntheticTransport,
	type TransportOptions,
} from "./synthetic-transport.ts";

export const PREFIX = "SYNTHETIC-PUSH-BEFORE";
export const SUFFIX = "SYNTHETIC-PUSH-AFTER";
export const SEPARATOR = "\n\n";

/** Effective text of a string-shaped message, spelled out so tests do not import the shaper. */
export function effectiveText(
	text: string,
	texts: { readonly prepend?: string; readonly append?: string },
): string {
	const prepend = texts.prepend ?? "";
	const append = texts.append ?? "";
	const head = prepend === "" ? text : `${prepend}${SEPARATOR}${text}`;
	return append === "" ? head : `${head}${SEPARATOR}${append}`;
}

export interface OpenedSession extends HarnessSession {
	readonly runtime: Runtime | undefined;
	/** Messages the extension reported through `ctx.ui.notify`. */
	readonly notices: Array<{ readonly message: string; readonly type: string }>;
	/** Text the extension put back into the editor. */
	readonly editorTexts: string[];
}

export interface OpenRequest {
	readonly sessionManager: SessionManager;
	/** Omit the extension entirely to build the plugin-free baseline. */
	readonly withExtension?: boolean;
	readonly model?: { readonly providerId: string; readonly modelId: string };
	readonly tools?: readonly string[];
	readonly projectTrusted?: boolean;
	/** Replays the reason Pi reports on session start, e.g. "fork" after building a fork. */
	readonly sessionStartReason?: "startup" | "reload" | "new" | "resume" | "fork";
	/** Thinking level, so a baseline can match a session that changed model. */
	readonly thinkingLevel?: AgentSession["thinkingLevel"];
	readonly settings?: {
		readonly compaction?: CompactionSettings;
		readonly retry?: RetrySettings;
	};
	/** Loaded before the extension. */
	readonly extensionsBefore?: InlineExtension[];
	/** Loaded after the extension. */
	readonly extensionsAfter?: InlineExtension[];
	/** Scripted answers for the dialogs a command opens. */
	readonly ui?: ScriptedUI;
	/** CLI flag values, set before Pi emits `session_start`. */
	readonly flags?: Readonly<Record<string, boolean | string>>;
}

export interface PushHarness {
	readonly sandbox: Sandbox;
	readonly transport: SyntheticTransport;
	open(request: OpenRequest): Promise<OpenedSession>;
	/** Writes a config file under the global or project root. */
	writeConfig(scope: "global" | "project", config: Record<string, unknown>): Promise<void>;
	/** Writes `prepend.md` and/or `append.md` of one profile. */
	writeProfile(
		scope: "global" | "project",
		id: string,
		texts: { readonly prepend?: string; readonly append?: string },
	): Promise<void>;
	/** Copy of a saved session file, for a plugin-free run over the same history. */
	copySession(sessionManager: SessionManager, suffix: string): Promise<string>;
}

function rootOf(sandbox: Sandbox, scope: "global" | "project"): string {
	return scope === "global"
		? join(sandbox.agentDir, "push-prompts")
		: join(sandbox.cwd, ".pi", "push-prompts");
}

/**
 * Answers the dialogs a command opens and records what each one offered.
 *
 * The terminal picker is built through `ui.custom`, so its factory runs for real
 * here — the title, the items and the terminal width go through the production
 * code — and only the answer is scripted. Nothing is painted and the list's key
 * handling is not exercised: the component is never rendered.
 */
export class ScriptedUI {
	private readonly choices: Array<string | undefined>;
	private readonly inputs: Array<string | undefined>;
	private readonly editors: Array<string | undefined>;
	private readonly confirms: Array<boolean | undefined>;
	/** Dialogs in the order they were opened, with what each one offered. */
	readonly dialogs: RecordedDialog[] = [];

	constructor(
		options: {
			readonly choices?: readonly (string | undefined)[];
			readonly inputs?: readonly string[];
			readonly editors?: readonly (string | undefined)[];
			readonly confirms?: readonly (boolean | undefined)[];
		} = {},
	) {
		this.choices = [...(options.choices ?? [])];
		this.inputs = [...(options.inputs ?? [])];
		this.editors = [...(options.editors ?? [])];
		this.confirms = [...(options.confirms ?? [])];
	}

	/**
	 * Answers for the dialogs the next command opens, in order. `undefined`
	 * dismisses a picker, which is what Esc does.
	 */
	answer(...answers: Array<string | undefined>): void {
		this.choices.push(...answers);
	}

	wrap(base: ExtensionUIContext): ExtensionUIContext {
		const next = (queue: Array<string | undefined>): string | undefined =>
			queue.shift();
		const nextConfirm = (): boolean | undefined => this.confirms.shift();
		const overrides = {
			custom: async (factory: unknown) => {
				const component = (
					factory as (...args: unknown[]) => {
						request?: { title: string; items: readonly { label: string }[] };
					}
				)(FAKE_TUI, FAKE_THEME, FAKE_KEYBINDINGS, () => {});
				// The picker keeps the request it was built from, so the dialog can be
				// reported without rendering it.
				const request = component.request;
				this.dialogs.push({
					kind: "picker",
					title: request?.title ?? "",
					labels: (request?.items ?? []).map((item) => item.label),
				});
				return next(this.choices);
			},
			select: async (title: string, options: string[]) => {
				this.dialogs.push({ kind: "select", title, labels: [...options] });
				const choice = next(this.choices);
				// An answer that is not on the list would silently pass the test.
				return choice !== undefined && options.includes(choice)
					? choice
					: undefined;
			},
			input: async (title: string) => {
				this.dialogs.push({ kind: "input", title, labels: [] });
				return next(this.inputs);
			},
			confirm: async (title: string, _message: string) => {
				this.dialogs.push({ kind: "confirm", title, labels: [] });
				return nextConfirm() ?? false;
			},
			editor: async (title: string) => {
				this.dialogs.push({ kind: "editor", title, labels: [] });
				return next(this.editors);
			},
		};
		return { ...base, ...overrides } as unknown as ExtensionUIContext;
	}
}

/** One dialog a scripted session opened. */
export interface RecordedDialog {
	readonly kind: "picker" | "select" | "input" | "confirm" | "editor";
	readonly title: string;
	/** What a picker or a selector offered, in order. */
	readonly labels: readonly string[];
}

const FAKE_TUI = { terminal: { rows: 24 } };
const FAKE_THEME = {};
const FAKE_KEYBINDINGS = {};

/**
 * Recording UI context. The SDK binds a no-op UI, so this is the only way to
 * observe what the user would see: notifications and the restored editor text.
 */
function recordingUI(
	base: ExtensionUIContext,
	notices: OpenedSession["notices"],
	editorTexts: string[],
): ExtensionUIContext {
	return {
		...base,
		notify(message, type) {
			notices.push({ message, type: type ?? "info" });
		},
		setEditorText(text) {
			editorTexts.push(text);
		},
	};
}

/**
 * Runs one test with an isolated sandbox, the synthetic transport and a
 * fake-auth runtime. Sessions are disposed in reverse order, then the transport
 * is restored and the sandbox removed, even when the test throws.
 *
 * `PI_SUBAGENT_CHILD` is cleared by default: a test run started by an agent may
 * carry it, and the extension would then apply the subagent policy instead of
 * the session one. `subagent: true` sets it back for the subagent test.
 */
export async function withPushHarness(
	run: (harness: PushHarness) => Promise<void>,
	transportOptions: TransportOptions = {},
	options: { readonly subagent?: boolean } = {},
): Promise<void> {
	const savedSubagentChild = process.env.PI_SUBAGENT_CHILD;
	if (options.subagent) {
		process.env.PI_SUBAGENT_CHILD = "1";
	} else {
		delete process.env.PI_SUBAGENT_CHILD;
	}
	const owned: AgentSession[] = [];
	let sandbox: Sandbox | undefined;
	let transport: SyntheticTransport | undefined;
	let failure: { readonly error: unknown } | undefined;
	try {
		sandbox = await createSandbox();
		transport = installSyntheticTransport(transportOptions);
		const activeSandbox = sandbox;
		const runtime: ModelRuntime = await createSyntheticRuntime({
			providers: ["anthropic", "openai", "google"],
		});
		const harness: PushHarness = {
			sandbox: activeSandbox,
			transport,
			async open(request) {
				const notices: OpenedSession["notices"] = [];
				const editorTexts: string[] = [];
				const factories: InlineExtension[] = [...(request.extensionsBefore ?? [])];
				let captured: Runtime | undefined;
				if (request.withExtension !== false) {
					factories.push((pi) => {
						captured = createPushPromptsExtension(pi);
					});
				}
				factories.push(...(request.extensionsAfter ?? []));
				const opened = await createHarnessSession({
					sandbox: activeSandbox,
					runtime,
					sessionManager: request.sessionManager,
					extensionFactories: factories,
					model: request.model,
					tools: request.tools,
					projectTrusted: request.projectTrusted,
					sessionStartReason: request.sessionStartReason,
					thinkingLevel: request.thinkingLevel,
					settings: request.settings,
				});
				owned.push(opened.session);
				const runner = opened.session.extensionRunner;
				// Flag values are part of the run, not of the session file: setting them
				// before the host emits `session_start` is what the CLI does.
				for (const [name, value] of Object.entries(request.flags ?? {})) {
					runner.setFlagValue(name, value);
				}
				// The SDK creates the session; the host is what binds UI and emits
				// `session_start`. Both are public, and both are needed to see what a
				// real session sees.
				const recording = recordingUI(
					runner.getUIContext(),
					notices,
					editorTexts,
				);
				await opened.session.bindExtensions({
					uiContext: request.ui ? request.ui.wrap(recording) : recording,
					mode: "tui",
				});
				return { ...opened, runtime: captured, notices, editorTexts };
			},
			async writeConfig(scope, config) {
				const directory = rootOf(activeSandbox, scope);
				await mkdir(directory, { recursive: true });
				await writeFile(
					join(directory, "config.json"),
					`${JSON.stringify({ version: 1, ...config }, null, 2)}\n`,
					"utf8",
				);
			},
			async writeProfile(scope, id, texts) {
				const directory = join(rootOf(activeSandbox, scope), "profiles", id);
				await mkdir(directory, { recursive: true });
				if (texts.prepend !== undefined) {
					await writeFile(join(directory, "prepend.md"), texts.prepend, "utf8");
				}
				if (texts.append !== undefined) {
					await writeFile(join(directory, "append.md"), texts.append, "utf8");
				}
			},
			async copySession(sessionManager, suffix) {
				const file = sessionManager.getSessionFile();
				assert.ok(file, "the session is persisted");
				const target = `${file}.${suffix}`;
				await copyFile(file, target);
				return target;
			},
		};
		await run(harness);
		assert.deepEqual(
			transport.takeBlockedUrls(),
			[],
			"no unexpected outbound route was attempted",
		);
	} catch (error) {
		failure = { error };
	}

	const cleanupFailures: unknown[] = [];
	for (const session of owned.reverse()) {
		try {
			session.dispose();
		} catch (error) {
			cleanupFailures.push(error);
		}
	}
	transport?.restore();
	try {
		await sandbox?.dispose();
	} catch (error) {
		cleanupFailures.push(error);
	}
	if (savedSubagentChild === undefined) {
		delete process.env.PI_SUBAGENT_CHILD;
	} else {
		process.env.PI_SUBAGENT_CHILD = savedSubagentChild;
	}
	if (failure) {
		throw failure.error;
	}
	if (cleanupFailures.length > 0) {
		throw cleanupFailures[0];
	}
}

/** Sends one prompt and returns the serialized body of its single provider request. */
export async function sendTurn(
	session: AgentSession,
	transport: SyntheticTransport,
	text: string,
): Promise<string> {
	const before = transport.requests.length;
	await session.prompt(text);
	assert.equal(
		transport.requests.length,
		before + 1,
		"exactly one provider request per prompt",
	);
	const reply = session.messages.at(-1);
	assert.ok(reply && reply.role === "assistant", "the last message is the reply");
	assert.equal(
		reply.stopReason,
		"stop",
		`the reply completed normally: ${reply.errorMessage ?? "no error message"}`,
	);
	assert.equal(
		contentText(reply.content),
		SYNTHETIC_REPLY_TEXT,
		"the reply is the synthetic transport text",
	);
	const request = transport.requests.at(-1);
	assert.ok(request, "provider request was captured");
	return request.body;
}

export function contentText(
	content: string | readonly { readonly type: string; readonly text?: string }[],
): string {
	if (typeof content === "string") {
		return content;
	}
	return content.map((block) => block.text ?? "").join("");
}

export function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function firstMismatchIndex(actual: string, expected: string): number {
	const shared = Math.min(actual.length, expected.length);
	for (let index = 0; index < shared; index += 1) {
		if (actual[index] !== expected[index]) {
			return index;
		}
	}
	return shared;
}

/**
 * Field path of the first structural difference, for the failure message. Only
 * names and indices are reported: a body never appears in a failure.
 */
function firstDifferingPath(actual: string, expected: string): string {
	const walk = (left: unknown, right: unknown, path: string): string | undefined => {
		if (typeof left !== typeof right) {
			return path;
		}
		if (Array.isArray(left) && Array.isArray(right)) {
			if (left.length !== right.length) {
				return `${path} (length ${left.length} vs ${right.length})`;
			}
			for (let index = 0; index < left.length; index += 1) {
				const found = walk(left[index], right[index], `${path}[${index}]`);
				if (found) {
					return found;
				}
			}
			return undefined;
		}
		if (
			left !== null &&
			right !== null &&
			typeof left === "object" &&
			typeof right === "object"
		) {
			const leftRecord = left as Record<string, unknown>;
			const rightRecord = right as Record<string, unknown>;
			const keys = new Set([
				...Object.keys(leftRecord),
				...Object.keys(rightRecord),
			]);
			for (const key of keys) {
				const found = walk(
					leftRecord[key],
					rightRecord[key],
					path === "$" ? key : `${path}.${key}`,
				);
				if (found) {
					return found;
				}
			}
			return undefined;
		}
		return left === right ? undefined : path;
	};
	try {
		return (
			walk(JSON.parse(actual), JSON.parse(expected), "$") ?? "$"
		);
	} catch {
		return "<not JSON>";
	}
}

/** Byte equality of two serialized bodies; a mismatch reports sizes, never content. */
export function assertSameSerialized(
	actual: string,
	expected: string,
	label: string,
): void {
	if (digest(actual) === digest(expected)) {
		return;
	}
	assert.fail(
		`${label} differs: lengths ${actual.length} vs ${expected.length}, ` +
			`first mismatch at index ${firstMismatchIndex(actual, expected)}, ` +
			`first differing field ${firstDifferingPath(actual, expected)}`,
	);
}

export function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** A string as it appears inside a serialized JSON body. */
export function escaped(text: string): string {
	return JSON.stringify(text).slice(1, -1);
}

export interface RequestView {
	readonly parsed: Record<string, unknown>;
	readonly items: readonly unknown[];
	readonly system: unknown;
}

export function requestView(provider: SyntheticProvider, body: string): RequestView {
	const parsed = JSON.parse(body) as Record<string, unknown>;
	if (provider === "anthropic") {
		return { parsed, items: parsed.messages as unknown[], system: parsed.system };
	}
	if (provider === "openai") {
		return { parsed, items: parsed.input as unknown[], system: parsed.instructions };
	}
	const config = parsed.config as Record<string, unknown> | undefined;
	return {
		parsed,
		items: parsed.contents as unknown[],
		system: config?.systemInstruction,
	};
}

/** Text of one serialized conversation item, per adapter shape. */
export function itemText(
	provider: SyntheticProvider,
	item: unknown,
): string | undefined {
	const record = item as Record<string, unknown> | undefined;
	if (!record) {
		return undefined;
	}
	const parts =
		provider === "google"
			? ((record.parts as Array<Record<string, unknown>> | undefined) ?? [])
			: typeof record.content === "string"
				? [{ text: record.content }]
				: ((record.content as Array<Record<string, unknown>> | undefined) ?? []);
	if (provider === "openai") {
		const content = record.content as Array<Record<string, unknown>> | undefined;
		return (content ?? [])
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.join("");
	}
	return parts
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
}

export function userMessages(
	sessionManager: SessionManager,
): Array<{ readonly text: string; readonly timestamp: number }> {
	return sessionManager.getEntries().flatMap((entry: SessionEntry) => {
		if (entry.type !== "message" || entry.message.role !== "user") {
			return [];
		}
		return [
			{
				text: contentText(entry.message.content),
				timestamp: entry.message.timestamp,
			},
		];
	});
}

export function appliedEntries(sessionManager: SessionManager): AppliedEntry[] {
	return sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== APPLIED_ENTRY_TYPE) {
			return [];
		}
		const parsed = parseAppliedEntry(entry.data);
		return parsed ? [parsed] : [];
	});
}

export function stateEntries(
	sessionManager: SessionManager,
): Array<Record<string, unknown>> {
	return sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) {
			return [];
		}
		return [entry.data as Record<string, unknown>];
	});
}

/** State entries of the active branch, root first: what the extension reads. */
export function branchStateEntries(
	sessionManager: SessionManager,
): Array<Record<string, unknown>> {
	return sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) {
			return [];
		}
		return [entry.data as Record<string, unknown>];
	});
}

/** Applied entries of the active branch, root first. */
export function branchAppliedEntries(
	sessionManager: SessionManager,
): AppliedEntry[] {
	return sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== APPLIED_ENTRY_TYPE) {
			return [];
		}
		const parsed = parseAppliedEntry(entry.data);
		return parsed ? [parsed] : [];
	});
}

export interface ProfileTexts {
	readonly prepend?: string;
	readonly append?: string;
}
