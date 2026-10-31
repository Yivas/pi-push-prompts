import "../support/pinned-pi-package.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type AgentSession,
	type CustomEntry,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	type InlineExtension,
	type ModelRuntime,
	ModelRuntime as ModelRuntimeClass,
	type PromptTemplate,
	type SessionEntry,
	SessionManager,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	createPushFinalizedFixture,
	EXTENSION_SEND_COMMAND,
	EXTENSION_SEND_TEXT,
	FINALIZED_ENTRY_TYPE,
	FINALIZED_METADATA_MARKER,
	type FinalizedEntryData,
	type FinalizedProfile,
	messageText,
	type TimelineEntry,
} from "../fixtures/push-finalized-fixture.ts";
import {
	createPushInputFixture,
	DECORATION_ENTRY_TYPE,
	type DecorationEntryData,
	type FixtureProfile,
	METADATA_ONLY_MARKER,
} from "../fixtures/push-input-fixture.ts";
import {
	createPushPairedFixture,
	PAIRED_ENTRY_TYPE,
	PAIRED_METADATA_MARKER,
	type PairedEntryData,
} from "../fixtures/push-paired-fixture.ts";
import {
	createHarnessSession,
	createSandbox,
	createSyntheticRuntime,
	type HarnessSession,
	isInsideDirectory,
	PLACEHOLDER_API_KEY,
	type Sandbox,
	SYNTHETIC_PROVIDER_ID,
} from "../support/isolated-session.ts";
import {
	installSyntheticTransport,
	SYNTHETIC_REPLY_TEXT,
	type SyntheticTransport,
	type TransportOptions,
} from "../support/synthetic-transport.ts";

/*
 * Integration harness for the input-decoration seam (plain input only).
 *
 * Boundary: a public Pi SDK session with the built-in Anthropic Messages adapter. The only
 * substitution is the outbound transport (globalThis.fetch). Assertions compare SHA-256 digests of the
 * serialized JSON body the adapter sends. Serialized comparison failures report lengths and mismatch
 * indexes, never request bodies or system text.
 *
 * The fixture is a test double for the contract. Production association, atomicity, slash and skill
 * expansion, queues, once-mode, and native TUI rendering are not proven here.
 */

const PLAIN_INPUT = "Synthetic plain input.";
const REPEATED_INPUT = "Synthetic repeated input.";
const PREFIX_ONE = "[PFX-ONE]\n";
const SUFFIX_ONE = "\n[SFX-ONE]";
const PREFIX_TWO = "[PFX-TWO]\n";
const SUFFIX_TWO = "\n[SFX-TWO]";
const SYNTHETIC_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ENABLED_ONE: FixtureProfile = { enabled: true, prepend: PREFIX_ONE, append: SUFFIX_ONE };
const ENABLED_TWO: FixtureProfile = { enabled: true, prepend: PREFIX_TWO, append: SUFFIX_TWO };
const OFF: FixtureProfile = { enabled: false, prepend: "", append: "" };

interface RequestContentBlock {
	readonly type: string;
	readonly text?: string;
}

interface RequestMessage {
	readonly role: string;
	readonly content: string | readonly RequestContentBlock[];
}

interface MessagesRequest {
	readonly system: unknown;
	readonly messages: readonly RequestMessage[];
}

interface OpenOptions {
	readonly sessionManager: SessionManager;
	readonly extensionFactories?: InlineExtension[];
	readonly runtime?: ModelRuntime;
	readonly promptTemplates?: PromptTemplate[];
}

interface Harness {
	readonly sandbox: Sandbox;
	readonly transport: SyntheticTransport;
	/** Opens a session that is disposed by withHarness even when an assertion fails. */
	open(options: OpenOptions): Promise<HarnessSession>;
}

/**
 * Runs one test with an isolated sandbox, the synthetic transport, and a fake-auth runtime. Every
 * session opened through the harness is disposed in reverse order, then the transport is restored and
 * the sandbox removed, even when the test or a setup step throws.
 */
async function withHarness(
	run: (harness: Harness) => Promise<void>,
	transportOptions: TransportOptions = {},
): Promise<void> {
	const owned: AgentSession[] = [];
	let sandbox: Sandbox | undefined;
	let transport: SyntheticTransport | undefined;
	let failure: { readonly error: unknown } | undefined;
	try {
		sandbox = await createSandbox();
		transport = installSyntheticTransport(transportOptions);
		const defaultRuntime = await createSyntheticRuntime();
		const activeSandbox = sandbox;
		const harness: Harness = {
			sandbox: activeSandbox,
			transport,
			async open(options) {
				const opened = await createHarnessSession({
					sandbox: activeSandbox,
					runtime: options.runtime ?? defaultRuntime,
					sessionManager: options.sessionManager,
					extensionFactories: options.extensionFactories,
					promptTemplates: options.promptTemplates,
				});
				owned.push(opened.session);
				return opened;
			},
		};
		await run(harness);
		assert.deepEqual(transport.takeBlockedUrls(), [], "no unexpected outbound route was attempted");
	} catch (error) {
		failure = { error };
	}

	const cleanupFailures = await releaseHarness(owned, transport, sandbox);
	if (failure) {
		throw failure.error;
	}
	if (cleanupFailures.length > 0) {
		throw cleanupFailures[0];
	}
}

/** Disposes every owned session, restores the transport, and removes the sandbox; collects failures. */
async function releaseHarness(
	sessions: AgentSession[],
	transport: SyntheticTransport | undefined,
	sandbox: Sandbox | undefined,
): Promise<unknown[]> {
	const failures: unknown[] = [];
	for (const session of sessions.reverse()) {
		try {
			session.dispose();
		} catch (error) {
			failures.push(error);
		}
	}
	transport?.restore();
	try {
		await sandbox?.dispose();
	} catch (error) {
		failures.push(error);
	}
	return failures;
}

function digest(text: string): string {
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

/** Compares digests; on mismatch reports lengths and the first differing index only. */
function assertSameSerialized(actual: string, expected: string, label: string): void {
	if (digest(actual) === digest(expected)) {
		return;
	}
	assert.fail(
		`${label} differs: lengths ${actual.length} vs ${expected.length}, ` +
			`first mismatch at index ${firstMismatchIndex(actual, expected)}`,
	);
}

function contentText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content.map((block) => block.text ?? "").join("");
}

function parseRequest(raw: string): MessagesRequest {
	return JSON.parse(raw) as MessagesRequest;
}

function requestText(message: RequestMessage | undefined): string {
	assert.ok(message, "request message exists");
	return contentText(message.content);
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * Sends one prompt and returns the serialized body of its single provider request. Also asserts that
 * the reply completed normally, so a provider error recorded as an assistant message cannot pass.
 */
async function sendTurn(
	session: AgentSession,
	transport: SyntheticTransport,
	text: string,
	options?: Parameters<AgentSession["prompt"]>[1],
): Promise<string> {
	const before = transport.requests.length;
	await session.prompt(text, options);
	assert.equal(transport.requests.length, before + 1, "exactly one provider request per prompt");

	const reply = session.messages.at(-1);
	assert.ok(reply && reply.role === "assistant", "the last message is the assistant reply");
	assert.equal(reply.stopReason, "stop", "the reply completed normally");
	assert.equal(reply.errorMessage, undefined, "the reply has no provider error");
	assert.equal(contentText(reply.content), SYNTHETIC_REPLY_TEXT, "the reply is the synthetic transport text");

	const request = transport.requests.at(-1);
	assert.ok(request, "provider request was captured");
	return request.body;
}

function decorationEntries(sessionManager: SessionManager): CustomEntry<DecorationEntryData>[] {
	return sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry<DecorationEntryData> =>
				entry.type === "custom" && entry.customType === DECORATION_ENTRY_TYPE,
		);
}

/** User messages as persisted in the session file, in order. */
function persistedUserTexts(sessionManager: SessionManager): string[] {
	return sessionManager.getEntries().flatMap((entry: SessionEntry) => {
		if (entry.type !== "message" || entry.message.role !== "user") {
			return [];
		}
		return [contentText(entry.message.content)];
	});
}

function sentinelSource(markerName: string): string {
	return [
		'import { writeFileSync } from "node:fs";',
		'import { join } from "node:path";',
		"export default function () {",
		`\twriteFileSync(join(process.env.PI_CODING_AGENT_DIR ?? "", ${JSON.stringify(markerName)}), "loaded");`,
		"}",
		"",
	].join("\n");
}

describe("push input seam through the built-in Anthropic Messages adapter", () => {
	it("off candidate sends a serialized request identical to the plugin-free baseline", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const baseline = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const baselineBody = await sendTurn(baseline.session, transport, PLAIN_INPUT);

			const candidateManager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const candidate = await open({
				sessionManager: candidateManager,
				extensionFactories: [createPushInputFixture(OFF)],
			});
			assert.equal(candidate.resourceLoader.getExtensions().extensions.length, 1, "candidate extension is loaded");
			const candidateBody = await sendTurn(candidate.session, transport, PLAIN_INPUT);

			assertSameSerialized(candidateBody, baselineBody, "off candidate serialized request");
			assert.equal(decorationEntries(candidateManager).length, 0, "off profile writes no decoration entry");
		});
	});

	it("enabled decoration wraps the new user text once inside the same user message", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const baseline = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const baselineBody = await sendTurn(baseline.session, transport, PLAIN_INPUT);

			const candidateManager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const candidate = await open({
				sessionManager: candidateManager,
				extensionFactories: [createPushInputFixture(ENABLED_ONE)],
			});
			const candidateBody = await sendTurn(candidate.session, transport, PLAIN_INPUT);

			const effective = `${PREFIX_ONE}${PLAIN_INPUT}${SUFFIX_ONE}`;
			const baselineRequest = parseRequest(baselineBody);
			const candidateRequest = parseRequest(candidateBody);
			assertSameSerialized(
				JSON.stringify(candidateRequest.system),
				JSON.stringify(baselineRequest.system),
				"system prompt",
			);
			assert.equal(candidateRequest.messages.length, baselineRequest.messages.length, "no message was added");

			const userMessage = candidateRequest.messages.at(-1);
			assert.equal(userMessage?.role, "user", "decorated text stays in the user role");
			assert.equal(requestText(userMessage), effective, "prepend and append surround the input literally");
			assert.equal(countOccurrences(requestText(userMessage), PLAIN_INPUT), 1, "input text appears once");

			// Replacing only the escaped decorated text must give the baseline body byte for byte.
			const escapedEffective = JSON.stringify(effective).slice(1, -1);
			const escapedPlain = JSON.stringify(PLAIN_INPUT).slice(1, -1);
			assertSameSerialized(
				candidateBody.replace(escapedEffective, escapedPlain),
				baselineBody,
				"serialized request with the decorated text replaced by the plain input",
			);
			assert.equal(candidateBody.includes(METADATA_ONLY_MARKER), false, "custom entry data is not sent");

			const [entry] = decorationEntries(candidateManager);
			assert.deepEqual(
				{ original: entry?.data?.original, effective: entry?.data?.effective },
				{ original: PLAIN_INPUT, effective },
				"custom entry stores original and effective text",
			);
			assert.deepEqual(persistedUserTexts(candidateManager), [effective], "persisted user message is effective");
		});
	});

	it("reopened session reconstructs the persisted effective message without recomputation", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const firstManager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const first = await open({
				sessionManager: firstManager,
				extensionFactories: [createPushInputFixture(ENABLED_ONE)],
			});
			const firstBody = await sendTurn(first.session, transport, PLAIN_INPUT);

			const sessionFile = firstManager.getSessionFile();
			assert.ok(sessionFile, "session is persisted to a file");
			const effective = `${PREFIX_ONE}${PLAIN_INPUT}${SUFFIX_ONE}`;

			const reopenedManager = SessionManager.open(sessionFile);
			const reopened = await open({
				sessionManager: reopenedManager,
				// A different profile would produce different text if the history were recomputed.
				extensionFactories: [createPushInputFixture({ enabled: true, prepend: "[CHANGED]\n", append: "" })],
			});
			const [restoredUser] = reopened.session.messages.filter((message) => message.role === "user");
			assert.ok(restoredUser && restoredUser.role === "user", "reopened context has the user message");
			assert.equal(contentText(restoredUser.content), effective, "reopened context holds the effective text");
			assert.equal(
				JSON.stringify(reopened.session.messages).includes(METADATA_ONLY_MARKER),
				false,
				"custom entry is not part of the reopened model context",
			);

			const followUpBody = await sendTurn(reopened.session, transport, "Synthetic follow-up input.");

			const firstRequest = parseRequest(firstBody);
			const followUpRequest = parseRequest(followUpBody);
			assertSameSerialized(
				JSON.stringify(followUpRequest.system),
				JSON.stringify(firstRequest.system),
				"reopened system prompt",
			);
			assert.equal(
				requestText(followUpRequest.messages[0]),
				effective,
				"history is sent with the persisted effective text",
			);
			assert.equal(
				requestText(followUpRequest.messages.at(-1)),
				"[CHANGED]\nSynthetic follow-up input.",
				"only the new message uses the current profile",
			);
			assert.deepEqual(
				decorationEntries(reopenedManager).map((entry) => entry.data?.effective),
				[effective, "[CHANGED]\nSynthetic follow-up input."],
				"only the new send appends a decoration; the historical entry is untouched",
			);
		});
	});

	it("later sends with edited or off profiles keep the historical effective prefix stable", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const profile: FixtureProfile = { ...ENABLED_ONE };
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({ sessionManager: manager, extensionFactories: [createPushInputFixture(profile)] });

			// The same original text three times: each decoration must stay tied to its own send.
			const firstBody = await sendTurn(session.session, transport, REPEATED_INPUT);
			Object.assign(profile, ENABLED_TWO);
			const secondBody = await sendTurn(session.session, transport, REPEATED_INPUT);
			Object.assign(profile, OFF);
			const thirdBody = await sendTurn(session.session, transport, REPEATED_INPUT);

			const effectiveOne = `${PREFIX_ONE}${REPEATED_INPUT}${SUFFIX_ONE}`;
			const effectiveTwo = `${PREFIX_TWO}${REPEATED_INPUT}${SUFFIX_TWO}`;
			const [first, second, third] = [firstBody, secondBody, thirdBody].map(parseRequest);
			assert.equal(requestText(second?.messages[0]), effectiveOne, "second request keeps the first effective text");
			assert.equal(requestText(second?.messages[2]), effectiveTwo, "second send uses the edited profile");
			assert.equal(requestText(third?.messages[0]), effectiveOne, "off send keeps the first effective text");
			assert.equal(requestText(third?.messages[2]), effectiveTwo, "off send keeps the edited effective text");
			assert.equal(requestText(third?.messages[4]), REPEATED_INPUT, "off send adds the plain input only");
			for (const request of [second, third]) {
				assertSameSerialized(JSON.stringify(request?.system), JSON.stringify(first?.system), "system prompt across sends");
			}

			assert.deepEqual(
				decorationEntries(manager).map((entry) => entry.data?.effective),
				[effectiveOne, effectiveTwo],
				"each enabled send records its own decoration; duplicate originals are not collapsed",
			);
			assert.deepEqual(
				persistedUserTexts(manager),
				[effectiveOne, effectiveTwo, REPEATED_INPUT],
				"persisted history keeps every finalized user message",
			);

			// Plugin-free replay of the same transcript: the effective texts are sent as ordinary input.
			const replay = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const replayBodies: string[] = [];
			for (const text of [effectiveOne, effectiveTwo, REPEATED_INPUT]) {
				replayBodies.push(await sendTurn(replay.session, transport, text));
			}
			assert.deepEqual(
				[firstBody, secondBody, thirdBody].map(digest),
				replayBodies.map(digest),
				"serialized request digests equal a plugin-free replay of the same effective texts",
			);
		});
	});

	it("consecutive identical input under the same profile keeps two decorations matching a literal replay", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const effective = `${PREFIX_ONE}${REPEATED_INPUT}${SUFFIX_ONE}`;
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({ sessionManager: manager, extensionFactories: [createPushInputFixture(ENABLED_ONE)] });
			const firstBody = await sendTurn(session.session, transport, REPEATED_INPUT);
			const secondBody = await sendTurn(session.session, transport, REPEATED_INPUT);

			assert.deepEqual(
				decorationEntries(manager).map((entry) => entry.data?.effective),
				[effective, effective],
				"each send records its own decoration",
			);
			assert.deepEqual(persistedUserTexts(manager), [effective, effective], "both finalized user messages are effective");

			const replay = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const replayFirst = await sendTurn(replay.session, transport, effective);
			const replaySecond = await sendTurn(replay.session, transport, effective);
			assert.deepEqual(
				[firstBody, secondBody].map(digest),
				[replayFirst, replaySecond].map(digest),
				"serialized request digests equal a plugin-free literal replay",
			);
		});
	});

	it("leaves an orphaned decoration entry when a rejected prompt persists no user message", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const noCredentialRuntime = await ModelRuntimeClass.create({
				credentials: {
					read: async () => undefined,
					list: async () => [],
					modify: async (_providerId, change) => change(undefined),
					delete: async () => {},
				},
				modelsPath: null,
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushInputFixture(ENABLED_ONE)],
				runtime: noCredentialRuntime,
			});

			await assert.rejects(session.session.prompt("Synthetic rejected input."), /No API key found/);

			assert.equal(transport.requests.length, 0, "no provider request was sent");
			assert.equal(decorationEntries(manager).length, 1, "decoration entry was written before the rejection");
			assert.deepEqual(persistedUserTexts(manager), [], "no user message was persisted for that decoration");
		});
	});

	it("resolves the registered entry renderer through the public runner (native TUI row not run)", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushInputFixture(ENABLED_ONE)],
			});
			await sendTurn(session.session, transport, PLAIN_INPUT);

			const [entry] = decorationEntries(manager);
			assert.ok(entry, "decoration entry exists");
			const renderer = session.session.extensionRunner.getEntryRenderer(DECORATION_ENTRY_TYPE);
			assert.ok(renderer, "the runner returns the renderer registered by the fixture");
			// The fixture renderer does not read the theme; a real TUI theme is part of the not-run native check.
			const component = renderer(entry, { expanded: false }, undefined as unknown as Theme);
			assert.deepEqual(component?.render(80), [`original (display only): ${PLAIN_INPUT}`]);
		});
	});

	it("fake transport rejects an unexpected outbound route (guard only; not evidence of Pi routing)", async () => {
		await withHarness(async ({ transport }) => {
			const unexpectedUrl = "https://example.invalid/v1/messages";
			await assert.rejects(fetch(unexpectedUrl, { method: "POST", body: "{}" }), /Blocked outbound request/);
			assert.deepEqual(transport.takeBlockedUrls(), [unexpectedUrl]);
		});
	});

	it("does not load personal or project extensions or skills when ambient discovery is disabled", async () => {
		await withHarness(async ({ sandbox, open }) => {
			const personalSentinel = join(sandbox.agentDir, "extensions", "personal-sentinel.ts");
			const projectSentinel = join(sandbox.cwd, ".pi", "extensions", "project-sentinel.ts");
			const personalMarker = join(sandbox.agentDir, "personal-sentinel-loaded.txt");
			const projectMarker = join(sandbox.agentDir, "project-sentinel-loaded.txt");
			await mkdir(join(sandbox.agentDir, "extensions"), { recursive: true });
			await mkdir(join(sandbox.cwd, ".pi", "extensions"), { recursive: true });
			await writeFile(personalSentinel, sentinelSource("personal-sentinel-loaded.txt"));
			await writeFile(projectSentinel, sentinelSource("project-sentinel-loaded.txt"));

			// Positive control: with ambient discovery allowed, both sentinels are discovered and run.
			const discoveringLoader = new DefaultResourceLoader({
				cwd: sandbox.cwd,
				agentDir: sandbox.agentDir,
				settingsManager: SettingsManager.inMemory({}),
				noContextFiles: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await discoveringLoader.reload();
			const discovered = discoveringLoader.getExtensions().extensions.map((extension) => extension.path);
			assert.ok(discovered.includes(personalSentinel), "positive control: personal sentinel is discovered");
			assert.ok(discovered.includes(projectSentinel), "positive control: project sentinel is discovered");
			assert.equal(await readFile(personalMarker, "utf8"), "loaded", "positive control: personal sentinel ran");
			assert.equal(await readFile(projectMarker, "utf8"), "loaded", "positive control: project sentinel ran");
			await rm(personalMarker);
			await rm(projectMarker);

			// Harness configuration: discovery is disabled, so no file-based extension or skill loads or runs.
			const harness = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			assert.deepEqual(
				harness.resourceLoader.getExtensions().extensions.map((extension) => extension.path),
				[],
				"no file-based extension is loaded",
			);
			assert.deepEqual(harness.resourceLoader.getSkills().skills, [], "no skill is loaded");
			await assert.rejects(readFile(personalMarker, "utf8"), { code: "ENOENT" }, "no personal sentinel ran");
			await assert.rejects(readFile(projectMarker, "utf8"), { code: "ENOENT" }, "no project sentinel ran");
		});
	});

	it("sandbox root and HOME redirect are outside the real home (lexical check; no personal listing)", async () => {
		const realHome = realpathSync(homedir());
		const sandbox = await createSandbox();
		try {
			assert.equal(
				isInsideDirectory(realpathSync(sandbox.root), realHome),
				false,
				"sandbox root is not under the real home",
			);
			assert.equal(process.env.HOME, sandbox.home, "HOME points inside the sandbox");
			assert.equal(process.env.USERPROFILE, sandbox.home, "USERPROFILE points inside the sandbox");
		} finally {
			await sandbox.dispose();
		}
	});
});

/**
 * Sends a command through the public session API and resolves only after the public `agent_settled` event,
 * with a bounded wait. The subscription is removed in every path so no listener outlives the test.
 */
async function runUntilSettled(session: AgentSession, start: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
	let unsubscribe = (): void => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settled = new Promise<void>((resolve, reject) => {
		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_settled") {
				resolve();
			}
		});
		timer = setTimeout(() => reject(new Error(`agent did not settle within ${timeoutMs} ms`)), timeoutMs);
	});
	try {
		await start();
		await settled;
	} finally {
		unsubscribe();
		clearTimeout(timer);
	}
}

/**
 * Appends a plain copy of each user message event to the timeline. Only strings and counts are kept, never
 * the live message object, so observing the history cannot change it.
 */
function recordListenerTimeline(
	session: AgentSession,
	timeline: TimelineEntry[],
	transport: SyntheticTransport,
	sessionManager: SessionManager,
): void {
	session.subscribe((event) => {
		if (event.type !== "message_start" && event.type !== "message_end") {
			return;
		}
		timeline.push({
			stage: event.type === "message_end" ? "message_end:listener" : "message_start",
			role: event.message.role,
			text: messageText(event.message),
			requestCount: transport.requests.length,
			persistedUserCount: persistedUserTexts(sessionManager).length,
		});
	});
}

/*
 * Replacing the finalized user message through the public `message_end` event, which is the seam the
 * extension uses. The tests here show that the replacement reaches the same-role user message, the
 * persisted entry and the serialized request, and that the raw input can be paired with the finalized
 * message. The input-only cases above stay as the contrast.
 */
describe("message_end replacement of a finalized user message", () => {
	const EXPANDED_TEMPLATE_BODY = "Synthetic template body.";
	const REJECTED_INPUT = "Synthetic rejected input.";
	const ACCEPTED_INPUT = "Synthetic accepted input.";

	function userTimeline(timeline: TimelineEntry[]): TimelineEntry[] {
		return timeline.filter((entry) => entry.stage === "input" || entry.role === "user");
	}

	function userStages(timeline: TimelineEntry[]): string[] {
		return userTimeline(timeline).map((entry) => entry.stage);
	}

	function userTexts(timeline: TimelineEntry[]): (string | undefined)[] {
		return userTimeline(timeline).map((entry) => entry.text);
	}

	function finalizedEntries(sessionManager: SessionManager): CustomEntry<FinalizedEntryData>[] {
		return sessionManager
			.getEntries()
			.filter(
				(entry): entry is CustomEntry<FinalizedEntryData> =>
					entry.type === "custom" && entry.customType === FINALIZED_ENTRY_TYPE,
			);
	}

	function lastRequestMessage(body: string): RequestMessage | undefined {
		return parseRequest(body).messages.at(-1);
	}

	function escapedJson(text: string): string {
		return JSON.stringify(text).slice(1, -1);
	}

	it("replaces the finalized user message with the same role before persistence, and sends the replacement", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const timeline: TimelineEntry[] = [];
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const candidate = await open({
				sessionManager: manager,
				extensionFactories: [createPushFinalizedFixture({ ...ENABLED_ONE }, timeline)],
			});
			recordListenerTimeline(candidate.session, timeline, transport, manager);
			const candidateBody = await sendTurn(candidate.session, transport, PLAIN_INPUT);
			const effective = `${PREFIX_ONE}${PLAIN_INPUT}${SUFFIX_ONE}`;

			assert.deepEqual(
				userStages(timeline),
				["input", "message_start", "message_end:extension", "message_end:listener"],
				"observed user-message event order",
			);
			assert.deepEqual(
				userTexts(timeline),
				[PLAIN_INPUT, PLAIN_INPUT, PLAIN_INPUT, effective],
				"text seen at each stage: the replacement appears only after the extension handler",
			);
			assert.deepEqual(
				timeline
					.filter((entry) => entry.role === "user" && entry.stage !== "message_end:extension")
					.map((entry) => [entry.requestCount, entry.persistedUserCount]),
				[
					[0, 0],
					[0, 0],
				],
				"no request was sent and no user message was persisted at message_start or message_end",
			);
			assert.deepEqual(persistedUserTexts(manager), [effective], "persisted user message is the replacement");
			assert.deepEqual(
				finalizedEntries(manager).map((entry) => entry.data?.expandedOriginal),
				[PLAIN_INPUT],
			);
			assert.equal(requestText(lastRequestMessage(candidateBody)), effective, "sent user text is the replacement");
			assert.equal(countOccurrences(candidateBody, escapedJson(PREFIX_ONE)), 1, "prefix is sent once");
			assert.equal(candidateBody.includes(FINALIZED_METADATA_MARKER), false, "custom entry data is not sent");

			// Position in the persisted tree: the custom entry is written before the finalized user message.
			const entries = manager.getEntries();
			const customIndex = entries.findIndex(
				(entry) => entry.type === "custom" && entry.customType === FINALIZED_ENTRY_TYPE,
			);
			const userIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
			assert.ok(customIndex >= 0 && userIndex >= 0, "both the custom entry and the user message are persisted");
			assert.ok(customIndex < userIndex, `custom entry index ${customIndex} precedes user message index ${userIndex}`);

			const baseline = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const baselineBody = await sendTurn(baseline.session, transport, PLAIN_INPUT);
			assertSameSerialized(
				candidateBody.replace(escapedJson(effective), escapedJson(PLAIN_INPUT)),
				baselineBody,
				"serialized request with the replacement reversed to the plain input",
			);
		});
	});

	it("off profile sends a serialized request identical to the plugin-free baseline", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const baseline = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const baselineBody = await sendTurn(baseline.session, transport, PLAIN_INPUT);

			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const candidate = await open({
				sessionManager: manager,
				extensionFactories: [createPushFinalizedFixture({ ...OFF }, [])],
			});
			const candidateBody = await sendTurn(candidate.session, transport, PLAIN_INPUT);

			assertSameSerialized(candidateBody, baselineBody, "off finalized fixture serialized request");
			assert.equal(finalizedEntries(manager).length, 0, "off profile writes no finalized entry");
			assert.deepEqual(persistedUserTexts(manager), [PLAIN_INPUT], "off profile persists the plain input");
		});
	});

	it("expands a synthetic prompt template natively before message_end; the finalized original is the expanded text", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const template: PromptTemplate = {
				name: "synthetic-note",
				description: "Synthetic template for the message_end test",
				content: EXPANDED_TEMPLATE_BODY,
				sourceInfo: createSyntheticSourceInfo("<synthetic-note>", { source: "synthetic-harness" }),
				filePath: "<synthetic-note>",
			};
			const timeline: TimelineEntry[] = [];
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushFinalizedFixture({ ...ENABLED_ONE }, timeline)],
				promptTemplates: [template],
			});
			recordListenerTimeline(session.session, timeline, transport, manager);
			const body = await sendTurn(session.session, transport, "/synthetic-note");
			const effective = `${PREFIX_ONE}${EXPANDED_TEMPLATE_BODY}${SUFFIX_ONE}`;

			assert.deepEqual(
				userTexts(timeline),
				["/synthetic-note", EXPANDED_TEMPLATE_BODY, EXPANDED_TEMPLATE_BODY, effective],
				"input is raw; message_start and the extension handler already see the expanded text",
			);
			assert.deepEqual(
				finalizedEntries(manager).map((entry) => entry.data?.expandedOriginal),
				[EXPANDED_TEMPLATE_BODY],
				"stored original is the EXPANDED text, not the raw typed input",
			);
			assert.deepEqual(persistedUserTexts(manager), [effective], "persisted user message is the replacement");
			assert.equal(requestText(lastRequestMessage(body)), effective, "sent user text is the replacement");
			assert.equal(body.includes("synthetic-note"), false, "raw command text is not sent");

			// Native-expansion baseline: a plugin-free session with the same template sends the expanded text.
			const baseline = await open({
				sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir),
				promptTemplates: [template],
			});
			const baselineBody = await sendTurn(baseline.session, transport, "/synthetic-note");
			assert.equal(
				requestText(lastRequestMessage(baselineBody)),
				EXPANDED_TEMPLATE_BODY,
				"plugin-free baseline expands the template natively",
			);
			assertSameSerialized(
				body.replace(escapedJson(effective), escapedJson(EXPANDED_TEMPLATE_BODY)),
				baselineBody,
				"serialized request with the replacement reversed to the native expansion",
			);
		});
	});

	it("keeps repeated originals and reopened history text-stable, digest-equal to a plugin-free replay", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const profile: FinalizedProfile = { ...ENABLED_ONE };
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushFinalizedFixture(profile, [])],
			});
			const bodyOne = await sendTurn(session.session, transport, REPEATED_INPUT);
			Object.assign(profile, ENABLED_TWO);
			const bodyTwo = await sendTurn(session.session, transport, REPEATED_INPUT);

			const sessionFile = manager.getSessionFile();
			assert.ok(sessionFile, "session is persisted to a file");
			const effectiveOne = `${PREFIX_ONE}${REPEATED_INPUT}${SUFFIX_ONE}`;
			const effectiveTwo = `${PREFIX_TWO}${REPEATED_INPUT}${SUFFIX_TWO}`;
			assert.deepEqual(persistedUserTexts(manager), [effectiveOne, effectiveTwo]);

			const reopenedManager = SessionManager.open(sessionFile);
			const reopened = await open({
				sessionManager: reopenedManager,
				extensionFactories: [createPushFinalizedFixture({ enabled: true, prepend: "[CHANGED]\n", append: "" }, [])],
			});
			const body = await sendTurn(reopened.session, transport, PLAIN_INPUT);
			const request = parseRequest(body);
			assert.equal(requestText(request.messages[0]), effectiveOne, "historical first message is unchanged");
			assert.equal(requestText(request.messages[2]), effectiveTwo, "historical second message is unchanged");
			assert.equal(
				requestText(request.messages.at(-1)),
				`[CHANGED]\n${PLAIN_INPUT}`,
				"only the new message uses the current profile",
			);
			assert.equal(countOccurrences(body, "[PFX-ONE]"), 1, "no reinjection of the first prefix");
			assert.equal(countOccurrences(body, "[PFX-TWO]"), 1, "no reinjection of the second prefix");
			assert.deepEqual(persistedUserTexts(reopenedManager), [effectiveOne, effectiveTwo, `[CHANGED]\n${PLAIN_INPUT}`]);
			assert.deepEqual(
				finalizedEntries(reopenedManager).map((entry) => entry.data?.expandedOriginal),
				[REPEATED_INPUT, REPEATED_INPUT, PLAIN_INPUT],
				"repeated originals each keep their own entry",
			);

			// Full serialized replay: a plugin-free session sends the literal effective texts as ordinary input.
			const replay = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const replayBodies: string[] = [];
			for (const text of [effectiveOne, effectiveTwo, `[CHANGED]\n${PLAIN_INPUT}`]) {
				replayBodies.push(await sendTurn(replay.session, transport, text));
			}
			assert.deepEqual(
				[bodyOne, bodyTwo, body].map(digest),
				replayBodies.map(digest),
				"each serialized request digest equals the plugin-free replay of the literal effective history",
			);
		});
	});

	it("a rejected send emits no finalized user event and writes no entry; gap: raw inputs keep the rejected text", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const runtime = await createSyntheticRuntime({ withApiKey: false });
			const timeline: TimelineEntry[] = [];
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				runtime,
				extensionFactories: [createPushFinalizedFixture({ ...ENABLED_ONE }, timeline)],
			});
			recordListenerTimeline(session.session, timeline, transport, manager);

			await assert.rejects(session.session.prompt(REJECTED_INPUT), /No API key found/);
			assert.equal(transport.requests.length, 0, "no provider request was sent");
			assert.deepEqual(userStages(timeline), ["input"], "the rejected input is observed; no finalized user event");
			assert.equal(finalizedEntries(manager).length, 0, "no entry is written for the rejected send");
			assert.deepEqual(persistedUserTexts(manager), []);

			await runtime.setRuntimeApiKey(SYNTHETIC_PROVIDER_ID, PLACEHOLDER_API_KEY);
			const body = await sendTurn(session.session, transport, ACCEPTED_INPUT);
			const effective = `${PREFIX_ONE}${ACCEPTED_INPUT}${SUFFIX_ONE}`;
			assert.deepEqual(
				finalizedEntries(manager).map((entry) => entry.data?.expandedOriginal),
				[ACCEPTED_INPUT],
				"exactly one finalized entry, for the accepted send",
			);
			assert.deepEqual(persistedUserTexts(manager), [effective]);
			assert.equal(requestText(lastRequestMessage(body)), effective, "sent user text is the accepted replacement");

			// Accepted-after-rejected serialized request equals a plugin-free send of the same plain input.
			const baseline = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const baselineBody = await sendTurn(baseline.session, transport, ACCEPTED_INPUT);
			assertSameSerialized(
				body.replace(escapedJson(effective), escapedJson(ACCEPTED_INPUT)),
				baselineBody,
				"accepted-after-rejected serialized request reversed to the plain input",
			);

			// Recorded limit: raw input events include the rejected send, and the public input event carries
			// no id that links it to the later finalized message.
			const rawInputs = timeline.filter((entry) => entry.stage === "input").map((entry) => entry.text);
			assert.deepEqual(rawInputs, [REJECTED_INPUT, ACCEPTED_INPUT], "raw input events include the rejected send");
			assert.notEqual(
				rawInputs[0],
				finalizedEntries(manager)[0]?.data?.expandedOriginal,
				"index-based pairing of the first raw input does not match the stored original in this sequence",
			);
		});
	});

	it("decorates an extension sendUserMessage because message_end carries no origin", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const timeline: TimelineEntry[] = [];
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushFinalizedFixture({ ...ENABLED_ONE }, timeline)],
			});
			recordListenerTimeline(session.session, timeline, transport, manager);

			const before = transport.requests.length;
			await runUntilSettled(session.session, () => session.session.prompt(`/${EXTENSION_SEND_COMMAND}`));
			assert.equal(transport.requests.length, before + 1, "the extension send produced one provider request");

			const inputEntry = timeline.find((entry) => entry.stage === "input");
			assert.equal(inputEntry?.text, EXTENSION_SEND_TEXT, "the input event carries the extension text");
			assert.equal(inputEntry?.source, "extension", "the input event reports the extension origin");
			const endEntry = timeline.find((entry) => entry.stage === "message_end:extension" && entry.role === "user");
			assert.equal(endEntry?.role, "user", "the finalized message is a user message");
			assert.equal(
				endEntry?.fields?.split(",").some((field) => field === "source" || field === "origin"),
				false,
				"the finalized message carries no origin field",
			);

			// A recorded limit: the extension send is decorated anyway, because the finalized message
			// carries no origin to skip on.
			const effective = `${PREFIX_ONE}${EXTENSION_SEND_TEXT}${SUFFIX_ONE}`;
			assert.deepEqual(persistedUserTexts(manager), [effective], "the extension send is decorated");
			assert.deepEqual(
				finalizedEntries(manager).map((entry) => entry.data?.expandedOriginal),
				[EXTENSION_SEND_TEXT],
			);
		});
	});

	it("leaves a user message with an image unchanged, without finalized metadata or lost attachments", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const options: Parameters<AgentSession["prompt"]>[1] = {
				images: [
					{
						type: "image",
						mimeType: "image/png",
						data: SYNTHETIC_PNG_BASE64,
					},
				],
			};
			const baseline = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const baselineBody = await sendTurn(baseline.session, transport, PLAIN_INPUT, options);
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const candidate = await open({
				sessionManager: manager,
				extensionFactories: [createPushFinalizedFixture({ ...ENABLED_ONE }, [])],
			});
			const candidateBody = await sendTurn(candidate.session, transport, PLAIN_INPUT, options);
			assertSameSerialized(candidateBody, baselineBody, "unsupported content passes through unchanged");
			assert.equal(finalizedEntries(manager).length, 0, "unsupported content writes no decoration metadata");
			const user = candidate.session.messages.find((message) => message.role === "user");
			assert.ok(user && user.role === "user" && Array.isArray(user.content), "user content remains structured");
			assert.equal(user.content.length, 2, "text and image blocks are both retained");
			assert.equal(user.content[1]?.type, "image", "image attachment is retained");
		});
	});

	it("keeps the same text but a different serialized historical message when the replacement is a string", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const candidate = await open({
				sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir),
				extensionFactories: [createPushFinalizedFixture({ ...ENABLED_ONE }, [], { replacementShape: "string" })],
			});
			await sendTurn(candidate.session, transport, REPEATED_INPUT);
			const candidateBody = await sendTurn(candidate.session, transport, REPEATED_INPUT);

			const effective = `${PREFIX_ONE}${REPEATED_INPUT}${SUFFIX_ONE}`;
			const replay = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			await sendTurn(replay.session, transport, effective);
			const replayBody = await sendTurn(replay.session, transport, effective);

			const historicalCandidate = parseRequest(candidateBody).messages[0];
			const historicalReplay = parseRequest(replayBody).messages[0];
			assert.equal(requestText(historicalCandidate), requestText(historicalReplay), "the historical text is identical");
			assert.notEqual(
				digest(JSON.stringify(historicalCandidate)),
				digest(JSON.stringify(historicalReplay)),
				"the string-shaped historical message serializes differently (the string shape changes the stored history)",
			);
		});
	});
});


/*
 * Input source pairing through `message_end`, tested through public hooks only (test/fixtures/push-paired-fixture.ts).
 * The cases below cover the pairing on ordinary paths, and then try to break its invariant: a raw original
 * must be paired with the run that produced it. A broken invariant is a passing test of the limitation, and
 * the pairing is then not fit to ship. No claim of compatibility, `once` or production use.
 */

const BOUNDED_TIMEOUT_MS = 10_000;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Rejects with a labeled error if the promise does not settle in time; the timer is always cleared. */
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} did not complete within ${BOUNDED_TIMEOUT_MS} ms`)),
					BOUNDED_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Resolves on the next public agent_settled event. The caller must call dispose in every path. */
function nextSettled(session: AgentSession): { readonly settled: Promise<void>; readonly dispose: () => void } {
	const { promise, resolve } = deferred();
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_settled") {
			resolve();
		}
	});
	return { settled: promise, dispose: unsubscribe };
}

function pairedEntries(sessionManager: SessionManager): CustomEntry<PairedEntryData>[] {
	return sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry<PairedEntryData> => entry.type === "custom" && entry.customType === PAIRED_ENTRY_TYPE,
		);
}

function pairedFields(sessionManager: SessionManager): object[] {
	return pairedEntries(sessionManager).map((entry) => ({
		rawOriginal: entry.data?.rawOriginal,
		expandedOriginal: entry.data?.expandedOriginal,
		effective: entry.data?.effective,
		source: entry.data?.snapshot.source,
		variant: entry.data?.variant,
	}));
}

function pairedRawOriginals(sessionManager: SessionManager): (string | undefined)[] {
	return pairedEntries(sessionManager).map((entry) => entry.data?.rawOriginal);
}

function stagesOf(timeline: TimelineEntry[]): string[] {
	return timeline.map((entry) => entry.stage);
}

function escapedText(text: string): string {
	return JSON.stringify(text).slice(1, -1);
}

describe("input source pairing through message_end", () => {
	const RAW_REJECTED = "Synthetic rejected input.";
	const RAW_ACCEPTED = "Synthetic accepted input.";
	const RAW_A = "Synthetic first input.";
	const RAW_B = "Synthetic second input.";
	const NATIVE_TEMPLATE_BODY = "Synthetic template body.";

	it("plain input: raw and effective text are recorded exactly, and the payload matches the reversed baseline", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const timeline: TimelineEntry[] = [];
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const candidate = await open({
				sessionManager: manager,
				extensionFactories: [createPushPairedFixture({ ...ENABLED_ONE }, timeline)],
			});
			const candidateBody = await sendTurn(candidate.session, transport, PLAIN_INPUT);
			const effective = `${PREFIX_ONE}${PLAIN_INPUT}${SUFFIX_ONE}`;

			assert.deepEqual(
				pairedFields(manager),
				[{ rawOriginal: PLAIN_INPUT, expandedOriginal: PLAIN_INPUT, effective, source: "interactive", variant: "input-pairing" }],
				"one metadata entry with the raw and effective text",
			);
			assert.deepEqual(
				stagesOf(timeline),
				["input", "before_agent_start", "message_end:paired"],
				"observed stage order of the candidate",
			);

			const baseline = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const baselineBody = await sendTurn(baseline.session, transport, PLAIN_INPUT);
			assertSameSerialized(
				candidateBody.replace(escapedText(effective), escapedText(PLAIN_INPUT)),
				baselineBody,
				"whole serialized payload with the replacement reversed to the plain input",
			);
			assert.equal(candidateBody.includes(PAIRED_METADATA_MARKER), false, "metadata is not sent");
		});
	});

	it("native template: the raw command is kept, the expanded text is composed once, and the payload matches the native baseline", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const template: PromptTemplate = {
				name: "synthetic-note",
				description: "Synthetic template for the input-pairing test",
				content: NATIVE_TEMPLATE_BODY,
				sourceInfo: createSyntheticSourceInfo("<synthetic-note>", { source: "synthetic-harness" }),
				filePath: "<synthetic-note>",
			};
			const timeline: TimelineEntry[] = [];
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const candidate = await open({
				sessionManager: manager,
				extensionFactories: [createPushPairedFixture({ ...ENABLED_ONE }, timeline)],
				promptTemplates: [template],
			});
			const candidateBody = await sendTurn(candidate.session, transport, "/synthetic-note");
			const effective = `${PREFIX_ONE}${NATIVE_TEMPLATE_BODY}${SUFFIX_ONE}`;

			assert.deepEqual(
				pairedFields(manager),
				[
					{
						rawOriginal: "/synthetic-note",
						expandedOriginal: NATIVE_TEMPLATE_BODY,
						effective,
						source: "interactive",
						variant: "input-pairing",
					},
				],
				"raw command kept as rawOriginal; expanded text composed once",
			);

			const baseline = await open({
				sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir),
				promptTemplates: [template],
			});
			const baselineBody = await sendTurn(baseline.session, transport, "/synthetic-note");
			assert.equal(
				requestText(parseRequest(baselineBody).messages.at(-1)),
				NATIVE_TEMPLATE_BODY,
				"the plugin-free baseline expands the template natively",
			);
			assertSameSerialized(
				candidateBody.replace(escapedText(effective), escapedText(NATIVE_TEMPLATE_BODY)),
				baselineBody,
				"whole serialized payload with the replacement reversed to the native expansion",
			);
		});
	});

	it("rejected then accepted: the rejected input is overwritten by the next input and the accepted send keeps its own raw original", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const runtime = await createSyntheticRuntime({ withApiKey: false });
			const timeline: TimelineEntry[] = [];
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				runtime,
				extensionFactories: [createPushPairedFixture({ ...ENABLED_ONE }, timeline)],
			});

			await assert.rejects(session.session.prompt(RAW_REJECTED), /No API key found/);
			assert.equal(transport.requests.length, 0, "the rejected send sent no request");
			assert.deepEqual(pairedFields(manager), [], "the rejected send wrote no metadata");

			await runtime.setRuntimeApiKey(SYNTHETIC_PROVIDER_ID, PLACEHOLDER_API_KEY);
			const body = await sendTurn(session.session, transport, RAW_ACCEPTED);
			const effective = `${PREFIX_ONE}${RAW_ACCEPTED}${SUFFIX_ONE}`;

			assert.deepEqual(
				pairedFields(manager),
				[{ rawOriginal: RAW_ACCEPTED, expandedOriginal: RAW_ACCEPTED, effective, source: "interactive", variant: "input-pairing" }],
				"the accepted send has exactly one entry, with its own raw original",
			);
			assert.equal(
				timeline.find((entry) => entry.stage === "before_agent_start")?.text,
				RAW_ACCEPTED,
				"the accepted run started with the accepted snapshot",
			);

			const baseline = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const baselineBody = await sendTurn(baseline.session, transport, RAW_ACCEPTED);
			assertSameSerialized(
				body.replace(escapedText(effective), escapedText(RAW_ACCEPTED)),
				baselineBody,
				"accepted-after-rejected payload with the replacement reversed",
			);
		});
	});

	it("extension sendUserMessage: the snapshot source is extension, so the first user message_end is skipped and not decorated", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const timeline: TimelineEntry[] = [];
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushPairedFixture({ ...ENABLED_ONE }, timeline)],
			});

			const before = transport.requests.length;
			await runUntilSettled(session.session, () => session.session.prompt(`/${EXTENSION_SEND_COMMAND}`));
			assert.equal(transport.requests.length, before + 1, "the extension send produced one provider request");

			const inputEntry = timeline.find((entry) => entry.stage === "input");
			assert.equal(inputEntry?.text, EXTENSION_SEND_TEXT, "the captured input is the extension text");
			assert.equal(inputEntry?.source, "extension", "the origin comes from the captured input event");
			assert.ok(
				stagesOf(timeline).includes("message_end:skipped:extension-origin"),
				"the user message_end is skipped for extension origin",
			);
			assert.deepEqual(pairedFields(manager), [], "no metadata for the extension send");
			assert.deepEqual(persistedUserTexts(manager), [EXTENSION_SEND_TEXT], "the extension message is persisted unchanged");
		});
	});

	it("leaves unsupported image content unchanged and records why the first user message was skipped", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const options: Parameters<AgentSession["prompt"]>[1] = {
				images: [{ type: "image", mimeType: "image/png", data: SYNTHETIC_PNG_BASE64 }],
			};
			const baseline = await open({ sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir) });
			const baselineBody = await sendTurn(baseline.session, transport, PLAIN_INPUT, options);
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const timeline: TimelineEntry[] = [];
			const candidate = await open({
				sessionManager: manager,
				extensionFactories: [createPushPairedFixture({ ...ENABLED_ONE }, timeline)],
			});
			const candidateBody = await sendTurn(candidate.session, transport, PLAIN_INPUT, options);
			assertSameSerialized(candidateBody, baselineBody, "paired fixture passes unsupported image through");
			assert.deepEqual(pairedFields(manager), [], "unsupported image writes no snapshot entry");
			assert.deepEqual(persistedUserTexts(manager), [PLAIN_INPUT], "image input text is not decorated");
			assert.ok(
				stagesOf(timeline).includes("message_end:skipped:unsupported-content"),
				"the first user message consumes the run snapshot but is skipped for its content shape",
			);
			const user = candidate.session.messages.find((message) => message.role === "user");
			assert.ok(user && user.role === "user" && Array.isArray(user.content), "content remains structured");
			assert.equal(user.content[1]?.type, "image", "image block is retained");
		});
	});

	it("pairs interleaved input handlers with the wrong raw text while model runs stay sequential", async () => {
		await withHarness(async ({ sandbox, open }) => {
			const gateA = deferred();
			const gateB = deferred();
			const arrivedA = deferred();
			const arrivedB = deferred();
			const timeline: TimelineEntry[] = [];
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [
					createPushPairedFixture({ ...ENABLED_ONE }, timeline, {
						inputGate: (rawText) => {
							if (rawText === RAW_A) {
								arrivedA.resolve();
								return gateA.promise;
							}
							arrivedB.resolve();
							return gateB.promise;
						},
					}),
				],
			});

			const settledA = nextSettled(session.session);
			let settledB: ReturnType<typeof nextSettled> | undefined;
			const promptA = session.session.prompt(RAW_A);
			// Input handling can overlap at an await; the model runs below are deliberately sequential.
			const promptB = session.session.prompt(RAW_B);
			const outcomes = Promise.allSettled([promptA, promptB]);
			try {
				await bounded(arrivedA.promise, "input A reached its gate");
				await bounded(arrivedB.promise, "input B reached its gate");
				gateA.resolve();
				await bounded(settledA.settled, "run A settled");
				settledB = nextSettled(session.session);
				gateB.resolve();
				await bounded(settledB.settled, "run B settled");
				const [outcomeA, outcomeB] = await bounded(outcomes, "both prompts observed");

				assert.equal(outcomeA?.status, "fulfilled", "prompt A resolved");
				assert.equal(outcomeB?.status, "fulfilled", "prompt B resolved");
				assert.equal(
					timeline.find((entry) => entry.stage === "before_agent_start")?.text,
					RAW_B,
					"run A started with the snapshot captured by input B",
				);
				assert.deepEqual(
					pairedFields(manager),
					[
						{
							rawOriginal: RAW_B,
							expandedOriginal: RAW_A,
							effective: `${PREFIX_ONE}${RAW_A}${SUFFIX_ONE}`,
							source: "interactive",
							variant: "input-pairing",
						},
					],
					"one entry, pairing run A's expanded text with raw B",
				);
				assert.deepEqual(
					persistedUserTexts(manager),
					[`${PREFIX_ONE}${RAW_A}${SUFFIX_ONE}`, RAW_B],
					"prompt B's user message is persisted undecorated",
				);
				assert.ok(
					stagesOf(timeline).includes("message_end:skipped:no-snapshot"),
					"the second user message has no accepted snapshot",
				);
			} finally {
				settledA.dispose();
				settledB?.dispose();
				gateA.resolve();
				gateB.resolve();
			}
		});
	});

	for (const mode of ["followUp", "steer"] as const) {
		it(`does not decorate a queued ${mode} sent while the first request is held at the transport boundary`, async () => {
			const release = deferred();
			const heldArrived = deferred();
			await withHarness(
				async ({ sandbox, transport, open }) => {
					const timeline: TimelineEntry[] = [];
					const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
					const session = await open({
						sessionManager: manager,
						extensionFactories: [createPushPairedFixture({ ...ENABLED_ONE }, timeline)],
					});

					const settled = nextSettled(session.session);
					const promptA = session.session.prompt(RAW_A);
					const outcomeA = Promise.allSettled([promptA]);
					try {
						await bounded(heldArrived.promise, "first request reached the transport boundary");
						const queued = session.session.prompt(RAW_B, { streamingBehavior: mode });
						const outcomeQueued = Promise.allSettled([queued]);
						release.resolve();
						await bounded(settled.settled, "run settled");
						await bounded(session.session.waitForIdle(), "session idle");
						const [a] = await bounded(outcomeA, "first prompt observed");
						const [q] = await bounded(outcomeQueued, "queued prompt observed");
						assert.equal(a?.status, "fulfilled", "first prompt resolved");
						assert.equal(q?.status, "fulfilled", "queued prompt resolved");
						assert.equal(transport.requests.length, 2, "two provider requests: the first run and the queued send");
						const queuedBody = transport.requests[1]?.body;
						assert.ok(queuedBody, "the queued send has a serialized provider request");
						const queuedUser = parseRequest(queuedBody).messages.at(-1);
						assert.equal(queuedUser?.role, "user", "the queued input remains a user message");
						assert.equal(requestText(queuedUser), RAW_B, "the provider receives queued B without decoration");
						assert.equal(countOccurrences(queuedBody, escapedText(PREFIX_ONE)), 1, "A's prefix is sent once");
						assert.ok(
							stagesOf(timeline).includes("message_end:skipped:already-consumed"),
							"the queued user message cannot consume the initial run snapshot again",
						);

						const startedRuns = stagesOf(timeline).filter((stage) => stage === "before_agent_start").length;
						assert.equal(startedRuns, 1, `only the first run passed before_agent_start (${mode})`);
						assert.deepEqual(
							pairedRawOriginals(manager),
							[RAW_A],
							`only the first run has metadata (${mode})`,
						);
						assert.deepEqual(
							persistedUserTexts(manager),
							[`${PREFIX_ONE}${RAW_A}${SUFFIX_ONE}`, RAW_B],
							`the queued ${mode} user message is persisted undecorated`,
						);
					} finally {
						settled.dispose();
						release.resolve();
					}
				},
				{
					beforeResponse: (index) => {
						if (index === 0) {
							heldArrived.resolve();
							return release.promise;
						}
						return undefined;
					},
				},
			);
		});
	}
});
