import "../support/pinned-pi-package.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CustomEntry,
	type InlineExtension,
	type ModelRuntime,
	type PromptOptions,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	createOtherDecoratorFixture,
	createPushContractFixture,
	FIXTURE_APPEND,
	FIXTURE_ENTRY_TYPE,
	FIXTURE_PREPEND,
	OTHER_APPEND,
	OTHER_ENTRY_TYPE,
	OTHER_PREPEND,
	SEND_FOLLOW_UP_COMMAND,
	SEND_IDLE_COMMAND,
	SEND_STEER_COMMAND,
	SENT_FOLLOW_UP_TEXT,
	SENT_IDLE_TEXT,
	SENT_STEER_TEXT,
	type AppliedEntryData,
	type OtherAppliedEntryData,
} from "../fixtures/push-contract-fixture.ts";
import {
	createHarnessSession,
	createSandbox,
	createSyntheticRuntime,
	type HarnessSession,
	SYNTHETIC_GOOGLE_MODEL_ID,
	SYNTHETIC_OPENAI_MODEL_ID,
	SYNTHETIC_PROVIDER_ID,
	type Sandbox,
} from "../support/isolated-session.ts";
import {
	installSyntheticTransport,
	SYNTHETIC_REPLY_TEXT,
	syntheticAnthropicToolCallStream,
	syntheticErrorResponse,
	type SyntheticProvider,
	type SyntheticTransport,
	type TransportOptions,
} from "../support/synthetic-transport.ts";

/*
 * Host contract for the `message_end` decoration seam. Boundary: public Pi SDK session, real
 * provider adapters, public extension API, and a simulated outbound transport. No TUI and no real
 * credentials. Assertions use SHA-256 digests or extracted text; request bodies are never printed.
 *
 * Covered here: re-emission under retry/continuation/reload, live object identity and reopened
 * content, timestamp and entry position in the session tree, two replacing extensions in both load
 * orders, sendUserMessage/steer/follow-up/abort/compaction, and serialized requests for Anthropic
 * Messages, OpenAI Responses, and Google Generative AI.
 */

const INPUT = "Synthetic input.";
const SECOND_INPUT = "Synthetic second input.";
const QUEUED_INPUT = "Synthetic queued input.";
const TOOL_INPUT = "Synthetic tool input.";
const TOOL_FILE_TEXT = "Synthetic tool file body.";
const NOTE = "\n\n";

function digest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function escaped(text: string): string {
	return JSON.stringify(text).slice(1, -1);
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

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null || !("content" in message)) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block: unknown) => {
			if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
				return block.text;
			}
			return "";
		})
		.join("");
}

function expectedEffective(text: string): string {
	return `${FIXTURE_PREPEND}${NOTE}${text}${NOTE}${FIXTURE_APPEND}`;
}

function persistedUserTexts(sessionManager: SessionManager): string[] {
	return sessionManager.getEntries().flatMap((entry: SessionEntry) => {
		if (entry.type !== "message" || entry.message.role !== "user") {
			return [];
		}
		return [messageText(entry.message)];
	});
}

function appliedEntries(sessionManager: SessionManager): CustomEntry<AppliedEntryData>[] {
	return sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry<AppliedEntryData> =>
				entry.type === "custom" && entry.customType === FIXTURE_ENTRY_TYPE,
		);
}

function otherEntries(sessionManager: SessionManager): CustomEntry<OtherAppliedEntryData>[] {
	return sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry<OtherAppliedEntryData> =>
				entry.type === "custom" && entry.customType === OTHER_ENTRY_TYPE,
		);
}

interface OpenOptions {
	readonly sessionManager: SessionManager;
	readonly extensionFactories?: InlineExtension[];
	readonly runtime?: ModelRuntime;
	readonly model?: { readonly providerId: string; readonly modelId: string };
	readonly tools?: readonly string[];
	readonly settings?: Parameters<typeof createHarnessSession>[0]["settings"];
}

interface Harness {
	readonly sandbox: Sandbox;
	readonly transport: SyntheticTransport;
	open(options: OpenOptions): Promise<HarnessSession>;
}

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
		const defaultRuntime = await createSyntheticRuntime({
			providers: [SYNTHETIC_PROVIDER_ID, "openai", "google"],
		});
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
					model: options.model,
					tools: options.tools,
					settings: options.settings,
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
	if (failure) {
		throw failure.error;
	}
	if (cleanupFailures.length > 0) {
		throw cleanupFailures[0];
	}
}

/** Sends one prompt and returns the serialized body of its single provider request. */
async function sendTurn(
	session: AgentSession,
	transport: SyntheticTransport,
	text: string,
	options?: PromptOptions,
): Promise<string> {
	const before = transport.requests.length;
	await session.prompt(text, options);
	assert.equal(transport.requests.length, before + 1, "exactly one provider request per prompt");
	const reply = session.messages.at(-1);
	assert.ok(reply && reply.role === "assistant", "the last message is the assistant reply");
	assert.equal(reply.stopReason, "stop", `the reply completed normally: ${reply.errorMessage ?? "no error message"}`);
	assert.equal(messageText(reply), SYNTHETIC_REPLY_TEXT, "the reply is the synthetic transport text");
	const request = transport.requests.at(-1);
	assert.ok(request, "provider request was captured");
	return request.body;
}

interface UserEventRecord {
	readonly type: string;
	readonly role?: string;
	readonly text?: string;
}

/** Records only plain values, never live message objects, so observing the session cannot change it. */
function recordEvents(session: AgentSession, events: UserEventRecord[]): void {
	session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start" || event.type === "message_end") {
			events.push({ type: event.type, role: event.message.role, text: messageText(event.message) });
			return;
		}
		if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
			events.push({ type: event.type });
		}
	});
}

function userEnds(events: UserEventRecord[]): string[] {
	return events.filter((event) => event.type === "message_end" && event.role === "user").map((event) => event.text ?? "");
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Resolves on the next public agent_settled event; the caller disposes the subscription in every path. */
function nextSettled(session: AgentSession): { readonly settled: Promise<void>; readonly dispose: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe = (): void => {};
	const settled = new Promise<void>((resolve, reject) => {
		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_settled") {
				clearTimeout(timer);
				resolve();
			}
		});
		timer = setTimeout(() => reject(new Error("agent did not settle within 10000 ms")), 10_000);
	});
	return {
		settled,
		dispose() {
			clearTimeout(timer);
			unsubscribe();
		},
	};
}

/** Resolves when the request at `index` reaches the transport boundary. */
function holdAt(index: number): {
	readonly options: TransportOptions;
	readonly arrived: Promise<void>;
	readonly release: () => void;
} {
	const arrived = deferred();
	const release = deferred();
	return {
		arrived: arrived.promise,
		release: release.resolve,
		options: {
			beforeResponse(requestIndex) {
				if (requestIndex !== index) {
					return undefined;
				}
				arrived.resolve();
				return release.promise;
			},
		},
	};
}

interface BodyView {
	readonly parsed: Record<string, unknown>;
	readonly items: readonly unknown[];
	readonly system: unknown;
}

function providerBody(provider: SyntheticProvider, body: string): BodyView {
	const parsed = JSON.parse(body) as Record<string, unknown>;
	if (provider === "anthropic") {
		return { parsed, items: parsed.messages as unknown[], system: parsed.system };
	}
	if (provider === "openai") {
		return { parsed, items: parsed.input as unknown[], system: parsed.instructions };
	}
	const config = parsed.config as Record<string, unknown> | undefined;
	return { parsed, items: parsed.contents as unknown[], system: config?.systemInstruction };
}

/** Anthropic marks earlier messages with cache_control breakpoints as the conversation grows; the comparison covers message content, not Pi's cache policy. */
function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(withoutCacheControl);
	}
	if (typeof value === "object" && value !== null) {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (key !== "cache_control") {
				result[key] = withoutCacheControl(entry);
			}
		}
		return result;
	}
	return value;
}

function comparableItems(items: readonly unknown[]): string {
	return JSON.stringify(withoutCacheControl(items));
}

function arrayContentDigest(text: string): string {
	return digest(JSON.stringify([{ type: "text", text }]));
}

function itemText(provider: SyntheticProvider, item: unknown): string | undefined {
	const record = item as Record<string, unknown>;
	if (provider === "anthropic") {
		return messageText(record);
	}
	if (provider === "openai") {
		const content = record.content;
		if (!Array.isArray(content)) {
			return undefined;
		}
		return content
			.map((part: unknown) => {
				const block = part as Record<string, unknown>;
				return block.type === "input_text" && typeof block.text === "string" ? block.text : "";
			})
			.join("");
	}
	const parts = record.parts;
	if (!Array.isArray(parts)) {
		return undefined;
	}
	return parts
		.map((part: unknown) => {
			const block = part as Record<string, unknown>;
			return typeof block.text === "string" ? block.text : "";
		})
		.join("");
}

describe("message_end re-emission and exactly-once decoration", () => {
	it("auto-retry after a simulated 500 re-sends the same decorated user message and emits user message_end once", async () => {
		const retryResponse = syntheticErrorResponse(500, "overloaded_error: server overloaded");
		await withHarness(
			async ({ sandbox, transport, open }) => {
				const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
				const session = await open({
					sessionManager: manager,
					extensionFactories: [createPushContractFixture()],
					settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 2 } },
				});
				const events: UserEventRecord[] = [];
				recordEvents(session.session, events);

				await session.session.prompt(INPUT);
				assert.equal(transport.requests.length, 2, "one failed request and one retried request");
				assert.deepEqual(
					events.filter((event) => event.type === "auto_retry_start" || event.type === "auto_retry_end"),
					[{ type: "auto_retry_start" }, { type: "auto_retry_end" }],
					"the host reported an automatic retry",
				);
				assert.deepEqual(userEnds(events), [expectedEffective(INPUT)], "one user message_end with the effective text");
				assert.equal(appliedEntries(manager).length, 1, "exactly one applied entry");
				assert.deepEqual(persistedUserTexts(manager), [expectedEffective(INPUT)], "one persisted effective user message");

				const [failed, retried] = transport.requests.map((request) => request.body);
				assert.ok(failed && retried, "both request bodies were captured");
				assert.equal(countOccurrences(failed, FIXTURE_PREPEND), 1, "failed request carries the prefix once");
				assert.equal(countOccurrences(retried, FIXTURE_PREPEND), 1, "retried request carries the prefix once");
				assertSameSerialized(
					JSON.stringify(providerBody("anthropic", retried).items),
					JSON.stringify(providerBody("anthropic", failed).items),
					"retried request messages",
				);
			},
			{
				responseFor: (index) => (index === 0 ? retryResponse : undefined),
			},
		);
	});

	it("overflow recovery does not re-emit user message_end and never duplicates the prefix", async () => {
		const overflow = syntheticErrorResponse(400, "prompt is too long: 200001 tokens > 200000 maximum");
		await withHarness(
			async ({ sandbox, transport, open }) => {
				const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
				const session = await open({
					sessionManager: manager,
					extensionFactories: [createPushContractFixture()],
					settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
				});
				const events: UserEventRecord[] = [];
				recordEvents(session.session, events);

				await session.session.prompt(INPUT);
				assert.ok(transport.requests.length >= 2, "overflow recovery sent a summary and a retry request");
				assert.deepEqual(userEnds(events), [expectedEffective(INPUT)], "one user message_end with the effective text");
				assert.equal(appliedEntries(manager).length, 1, "exactly one applied entry");
				assert.deepEqual(persistedUserTexts(manager), [expectedEffective(INPUT)], "one persisted effective user message");
				for (const request of transport.requests) {
					assert.ok(
						countOccurrences(request.body, FIXTURE_PREPEND) <= 1,
						"the prefix is never duplicated, even across the compaction boundary",
					);
				}
			},
			{ responseFor: (index) => (index === 0 ? overflow : undefined) },
		);
	});

	it("continues after a tool call without re-emitting user message_end and keeps the user message identical", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			await writeFile(join(sandbox.cwd, "synthetic-tool-input.txt"), TOOL_FILE_TEXT);
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushContractFixture()],
				tools: ["read"],
			});
			const events: UserEventRecord[] = [];
			recordEvents(session.session, events);

			await session.session.prompt(TOOL_INPUT);
			assert.equal(transport.requests.length, 2, "one request for the user turn and one continuation");
			assert.deepEqual(userEnds(events), [expectedEffective(TOOL_INPUT)], "user message_end fired once");
			assert.equal(appliedEntries(manager).length, 1, "exactly one applied entry");

			const [first, continuation] = transport.requests.map((request) => providerBody("anthropic", request.body));
			assert.ok(first && continuation, "both request bodies were captured");
			assert.equal(itemText("anthropic", first.items.at(-1)), expectedEffective(TOOL_INPUT), "first request is effective");
			assert.equal(
				continuation.items.length,
				first.items.length + 2,
				"continuation adds the assistant tool call and the tool result",
			);
			assertSameSerialized(comparableItems([continuation.items[0]]), comparableItems([first.items[0]]), "user message");
			assert.equal(countOccurrences(transport.requests[1]?.body ?? "", FIXTURE_PREPEND), 1, "prefix appears once");
		}, {
			responseFor: (index) =>
				index === 0
					? syntheticAnthropicToolCallStream({
							id: "toolu_synthetic_1",
							name: "read",
							argumentsJson: JSON.stringify({ path: "synthetic-tool-input.txt" }),
						})
					: undefined,
		});
	});

	it("reload with a queued follow-up emits user message_end once per message and decorates each once", async () => {
		const hold = holdAt(0);
		await withHarness(
			async ({ sandbox, transport, open }) => {
				const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
				const session = await open({
					sessionManager: manager,
					extensionFactories: [createPushContractFixture()],
				});
				const events: UserEventRecord[] = [];
				recordEvents(session.session, events);

				const firstPrompt = session.session.prompt(INPUT);
				await hold.arrived;
				await session.session.prompt(`/${SEND_FOLLOW_UP_COMMAND}`);
				await session.session.reload();
				hold.release();
				await firstPrompt;
				await session.session.waitForIdle();

				assert.equal(transport.requests.length, 2, "the queued message produced a second request after reload");
				assert.deepEqual(
					userEnds(events).sort(),
					[expectedEffective(INPUT), expectedEffective(SENT_FOLLOW_UP_TEXT)].sort(),
					"each user message was finalized exactly once with the effective text",
				);
				assert.equal(appliedEntries(manager).length, 2, "each delivered message has its own applied entry");
				assert.deepEqual(
					transport.requests.map((request) => countOccurrences(request.body, FIXTURE_PREPEND)),
					[1, 2],
					"one prefix per decorated message in the accumulated history",
				);
			},
			hold.options,
		);
	});
});

describe("live object identity and reopened content", () => {
	it("the message_start listener object is the object mutated at message_end and persisted", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushContractFixture()],
			});
			let started: unknown;
			let ended: unknown;
			let startedText: string | undefined;
			let endedText: string | undefined;
			session.session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "user") {
					started = event.message;
					startedText = messageText(event.message);
				}
				if (event.type === "message_end" && event.message.role === "user") {
					ended = event.message;
					endedText = messageText(event.message);
				}
			});

			const body = await sendTurn(session.session, transport, INPUT);
			assert.equal(startedText, INPUT, "the listener saw the pre-decoration content");
			assert.equal(endedText, expectedEffective(INPUT), "the later listener saw the mutated content");
			assert.equal(started, ended, "both listeners received the same object reference");
			assert.equal(
				started,
				session.session.messages.find((message) => message.role === "user"),
				"the same object is in agent state after settlement",
			);
			assert.equal(itemText("anthropic", providerBody("anthropic", body).items.at(-1)), expectedEffective(INPUT));
			// The native interactive row is drawn from message_start and not updated by message_end:
			// running the TUI is not part of this harness (not-run, no TTY).
		});
	});

	it("reopen keeps the effective user entry, and loading the fixture again does not decorate history", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const first = await open({
				sessionManager: manager,
				extensionFactories: [createPushContractFixture()],
			});
			await sendTurn(first.session, transport, INPUT);
			const sessionFile = manager.getSessionFile();
			assert.ok(sessionFile, "session is persisted to a file");
			const withoutFixtureFile = `${sessionFile}.without-fixture`;
			await copyFile(sessionFile, withoutFixtureFile);

			const withFixtureManager = SessionManager.open(sessionFile);
			const withFixture = await open({
				sessionManager: withFixtureManager,
				extensionFactories: [createPushContractFixture()],
			});
			const withoutFixtureManager = SessionManager.open(withoutFixtureFile);
			const withoutFixture = await open({ sessionManager: withoutFixtureManager });

			assert.deepEqual(
				persistedUserTexts(withFixtureManager),
				[expectedEffective(INPUT)],
				"reopened persisted entry holds the effective text",
			);
			assert.equal(appliedEntries(withFixtureManager).length, 1, "reload does not append a second applied entry");
			assertSameSerialized(
				JSON.stringify(withFixture.session.messages),
				JSON.stringify(withoutFixture.session.messages),
				"reopened model context with and without the fixture",
			);

			const withFixtureBody = await sendTurn(withFixture.session, transport, SECOND_INPUT);
			const withoutFixtureBody = await sendTurn(withoutFixture.session, transport, SECOND_INPUT);
			const withFixtureView = providerBody("anthropic", withFixtureBody);
			const withoutFixtureView = providerBody("anthropic", withoutFixtureBody);
			assertSameSerialized(
				JSON.stringify(withFixtureView.items.slice(0, withoutFixtureView.items.length - 1)),
				JSON.stringify(withoutFixtureView.items.slice(0, -1)),
				"reopened request prefix",
			);
			const effective = expectedEffective(SECOND_INPUT);
			assert.equal(itemText("anthropic", withFixtureView.items.at(-1)), effective, "new message is decorated");
			assert.equal(itemText("anthropic", withoutFixtureView.items.at(-1)), SECOND_INPUT, "baseline new message is plain");
			assertSameSerialized(
				JSON.stringify(withFixtureView.items.at(-1)).replace(escaped(effective), escaped(SECOND_INPUT)),
				JSON.stringify(withoutFixtureView.items.at(-1)),
				"new message with the inserted text removed",
			);
		});
	});
});

describe("timestamp and entry position in the session tree", () => {
	it("user message has a timestamp at message_end and the applied entry precedes it on the parent chain", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const observed: number[] = [];
			const session = await open({
				sessionManager: manager,
				extensionFactories: [
					createPushContractFixture({ onUserMessage: (message) => observed.push(message.timestamp) }),
				],
			});
			await sendTurn(session.session, transport, INPUT);

			const [entry] = appliedEntries(manager);
			assert.ok(entry, "applied entry exists");
			assert.equal(typeof entry.data?.timestamp, "number", "timestamp is a number");
			assert.ok((entry.data?.timestamp ?? 0) > 0, "timestamp is set");
			assert.deepEqual(observed, [entry.data?.timestamp], "handler saw the same timestamp");
			assert.equal(entry.data?.role, "user", "recorded role is user");

			const entries = manager.getEntries();
			const appliedId = entry.id;
			const userEntry = entries.find(
				(entry): entry is Extract<SessionEntry, { type: "message" }> =>
					entry.type === "message" && entry.message.role === "user",
			);
			assert.ok(userEntry, "user message entry exists");
			assert.equal(userEntry.message.timestamp, entry.data?.timestamp, "user message timestamp matches the entry");
			assert.equal(userEntry.parentId, appliedId, "the user message is a direct child of the applied entry");
		});
	});

	for (const order of ["push-first", "other-first"] as const) {
		it(`with two extensions writing entries (${order}) both entries precede the user message in the parent chain`, async () => {
			await withHarness(async ({ sandbox, transport, open }) => {
				const factories =
					order === "push-first"
						? [createPushContractFixture(), createOtherDecoratorFixture()]
						: [createOtherDecoratorFixture(), createPushContractFixture()];
				const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
				const session = await open({ sessionManager: manager, extensionFactories: factories });
				await sendTurn(session.session, transport, INPUT);

				const entries = manager.getEntries();
				const pushEntry = appliedEntries(manager)[0];
				const other = otherEntries(manager)[0];
				const user = entries.find(
					(entry): entry is Extract<SessionEntry, { type: "message" }> =>
						entry.type === "message" && entry.message.role === "user",
				);
				assert.ok(pushEntry && other && user, "both custom entries and the user message exist");
				const pushIndex = entries.findIndex((entry) => entry.id === pushEntry.id);
				const otherIndex = entries.findIndex((entry) => entry.id === other.id);
				const userIndex = entries.findIndex((entry) => entry.id === user.id);
				assert.ok(pushIndex < userIndex && otherIndex < userIndex, "both entries precede the user message");

				if (order === "push-first") {
					assert.ok(pushIndex < otherIndex, "handler order is preserved");
					assert.equal(other.parentId, pushEntry.id, "other entry is a child of the Push entry");
					assert.equal(user.parentId, other.id, "user message is a child of the last entry written");
				} else {
					assert.ok(otherIndex < pushIndex, "handler order is preserved");
					assert.equal(pushEntry.parentId, other.id, "Push entry is a child of the other entry");
					assert.equal(user.parentId, pushEntry.id, "user message is a child of the last entry written");
				}
			});
		});
	}
});

describe("two extensions replacing the same user message", () => {
	for (const order of ["push-first", "other-first"] as const) {
		it(`records the final content and digest validity in load order ${order}`, async () => {
			await withHarness(async ({ sandbox, transport, open }) => {
				const factories =
					order === "push-first"
						? [createPushContractFixture(), createOtherDecoratorFixture()]
						: [createOtherDecoratorFixture(), createPushContractFixture()];
				const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
				const session = await open({ sessionManager: manager, extensionFactories: factories });
				const body = await sendTurn(session.session, transport, INPUT);

				const pushEffective = expectedEffective(INPUT);
				const otherEffective = `${OTHER_PREPEND}${NOTE}${INPUT}${NOTE}${OTHER_APPEND}`;
				const finalText =
					order === "push-first"
						? `${OTHER_PREPEND}${NOTE}${pushEffective}${NOTE}${OTHER_APPEND}`
						: `${FIXTURE_PREPEND}${NOTE}${otherEffective}${NOTE}${FIXTURE_APPEND}`;

				assert.deepEqual(persistedUserTexts(manager), [finalText], "persisted user message holds the final content");
				assert.equal(
					itemText("anthropic", providerBody("anthropic", body).items.at(-1)),
					finalText,
					"sent user message holds the final content",
				);
				assert.equal(countOccurrences(body, FIXTURE_PREPEND), 1, "the Push prefix appears once");
				assert.equal(countOccurrences(body, OTHER_PREPEND), 1, "other prefix appears once");

				const pushEntry = appliedEntries(manager)[0];
				const other = otherEntries(manager)[0];
				assert.ok(pushEntry && other, "both entries exist");
				if (order === "push-first") {
					assert.equal(pushEntry.data?.effectiveDigest, arrayContentDigest(pushEffective), "the Push digest covers its own replacement");
					assert.notEqual(pushEntry.data?.effectiveDigest, arrayContentDigest(finalText), "the Push digest no longer matches the final text");
					assert.equal(other.data?.effectiveDigest, arrayContentDigest(finalText), "the later extension digest covers the final text");
				} else {
					assert.equal(pushEntry.data?.effectiveDigest, arrayContentDigest(finalText), "Push ran last, so its digest matches the final text");
					assert.equal(other.data?.effectiveDigest, arrayContentDigest(otherEffective), "other digest covers its own replacement");
				}
			});
		});
	}
});

describe("sendUserMessage, queues, abort, and compaction", () => {
	it("pi.sendUserMessage while idle is decorated once when it finalizes", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushContractFixture()],
			});
			const before = transport.requests.length;
			const signal = nextSettled(session.session);
			try {
				await session.session.prompt(`/${SEND_IDLE_COMMAND}`);
				await signal.settled;
			} finally {
				signal.dispose();
			}
			assert.equal(transport.requests.length, before + 1, "the extension send produced one provider request");
			assert.deepEqual(persistedUserTexts(manager), [expectedEffective(SENT_IDLE_TEXT)], "extension send is decorated");
			assert.equal(appliedEntries(manager).length, 1, "one applied entry");
		});
	});

	for (const [command, text] of [
		[SEND_STEER_COMMAND, SENT_STEER_TEXT],
		[SEND_FOLLOW_UP_COMMAND, SENT_FOLLOW_UP_TEXT],
	] as const) {
		it(`pi.sendUserMessage with deliverAs ${command.includes("steer") ? "steer" : "followUp"} during streaming is decorated once when delivered`, async () => {
			const hold = holdAt(0);
			await withHarness(
				async ({ sandbox, transport, open }) => {
					const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
					const session = await open({
						sessionManager: manager,
						extensionFactories: [createPushContractFixture()],
					});
					const firstPrompt = session.session.prompt(INPUT);
					await hold.arrived;
					await session.session.prompt(`/${command}`);
					hold.release();
					await firstPrompt;
					await session.session.waitForIdle();

					assert.equal(transport.requests.length, 2, "the queued extension send produced a second request");
					assert.deepEqual(
						persistedUserTexts(manager).sort(),
						[expectedEffective(INPUT), expectedEffective(text)].sort(),
						"both delivered user messages are decorated",
					);
					assert.equal(appliedEntries(manager).length, 2, "one applied entry per delivered message");
					assert.deepEqual(
						transport.requests.map((request) => countOccurrences(request.body, FIXTURE_PREPEND)),
						[1, 2],
						"one prefix per decorated message in the accumulated history",
					);
				},
				hold.options,
			);
		});
	}

	it("clearing a queued follow-up prevents its delivery and decoration", async () => {
		const hold = holdAt(0);
		await withHarness(
			async ({ sandbox, transport, open }) => {
				const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
				const session = await open({
					sessionManager: manager,
					extensionFactories: [createPushContractFixture()],
				});
				const firstPrompt = session.session.prompt(INPUT);
				await hold.arrived;
				await session.session.prompt(QUEUED_INPUT, { streamingBehavior: "followUp" });
				const cleared = session.session.clearQueue();
				hold.release();
				await firstPrompt;
				await session.session.waitForIdle();

				assert.deepEqual(cleared.followUp, [QUEUED_INPUT], "the queued text was returned to the caller");
				assert.equal(transport.requests.length, 1, "the cleared message produced no request");
				assert.deepEqual(persistedUserTexts(manager), [expectedEffective(INPUT)], "only the first message is persisted");
				assert.equal(appliedEntries(manager).length, 1, "the cleared message is not decorated");
			},
			hold.options,
		);
	});

	it("aborting a run with a queued message does not deliver or decorate it", async () => {
		const hold = holdAt(0);
		await withHarness(
			async ({ sandbox, transport, open }) => {
				const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
				const session = await open({
					sessionManager: manager,
					extensionFactories: [createPushContractFixture()],
				});
				const firstPrompt = session.session.prompt(INPUT);
				await hold.arrived;
				await session.session.prompt(QUEUED_INPUT, { streamingBehavior: "followUp" });
				const aborting = session.session.abort();
				hold.release();
				await aborting;
				await firstPrompt;
				await session.session.waitForIdle();

				assert.equal(transport.requests.length, 1, "the abort stopped the run before the queued message");
				assert.deepEqual(persistedUserTexts(manager), [expectedEffective(INPUT)], "queued message was not persisted");
				assert.equal(appliedEntries(manager).length, 1, "queued message was not decorated");
				const remaining = session.session.clearQueue();
				assert.deepEqual(remaining.followUp, [QUEUED_INPUT], "host keeps the queued message until it is cleared");
			},
			hold.options,
		);
	});

	it("manual compaction does not re-finalize or redecorate the user message", async () => {
		await withHarness(async ({ sandbox, transport, open }) => {
			const manager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
			const session = await open({
				sessionManager: manager,
				extensionFactories: [createPushContractFixture()],
				settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			});
			const events: UserEventRecord[] = [];
			recordEvents(session.session, events);
			await sendTurn(session.session, transport, INPUT);
			await sendTurn(session.session, transport, SECOND_INPUT);
			assert.equal(appliedEntries(manager).length, 2, "two decorations before compaction");

			const result = await session.session.compact();
			assert.ok(result.summary.length > 0, "manual compaction produced a summary");
			assert.equal(userEnds(events).length, 2, "compaction emitted no extra user message_end");
			assert.equal(appliedEntries(manager).length, 2, "compaction appended no applied entry");
			assert.deepEqual(
				persistedUserTexts(manager),
				[expectedEffective(INPUT), expectedEffective(SECOND_INPUT)],
				"persisted user entries are unchanged by compaction",
			);
		});
	});
});

describe("serialized requests for three adapters", () => {
	const providers = [
		{ provider: "anthropic", providerId: "anthropic", modelId: "claude-sonnet-4-5" },
		{ provider: "openai", providerId: "openai", modelId: SYNTHETIC_OPENAI_MODEL_ID },
		{ provider: "google", providerId: "google", modelId: SYNTHETIC_GOOGLE_MODEL_ID },
	] as const;

	for (const { provider, providerId, modelId } of providers) {
		it(`${provider} sends the baseline prefix unchanged, the inserted text once, and repeats it after a later send and reopen`, async () => {
			await withHarness(async ({ sandbox, transport, open }) => {
				const runtime = await createSyntheticRuntime({ providers: [providerId] });
				const baseline = await open({
					sessionManager: SessionManager.create(sandbox.cwd, sandbox.sessionDir),
					runtime,
					model: { providerId, modelId },
				});
				const candidateManager = SessionManager.create(sandbox.cwd, sandbox.sessionDir);
				const candidate = await open({
					sessionManager: candidateManager,
					runtime,
					model: { providerId, modelId },
					extensionFactories: [createPushContractFixture()],
				});

				const baselineFirst = providerBody(provider, await sendTurn(baseline.session, transport, INPUT));
				const candidateFirst = providerBody(provider, await sendTurn(candidate.session, transport, INPUT));
				const effective = expectedEffective(INPUT);

				assertSameSerialized(
					JSON.stringify(candidateFirst.system ?? null),
					JSON.stringify(baselineFirst.system ?? null),
					`${provider} system prompt`,
				);
				assert.equal(candidateFirst.items.length, baselineFirst.items.length, `${provider} item count`);
				assertSameSerialized(
					comparableItems(candidateFirst.items.slice(0, -1)),
					comparableItems(baselineFirst.items.slice(0, -1)),
					`${provider} prefix before the new message`,
				);
				const candidateMessage = candidateFirst.items.at(-1);
				const baselineMessage = baselineFirst.items.at(-1);
				assert.equal(itemText(provider, candidateMessage), effective, `${provider} new message text`);
				assertSameSerialized(
					JSON.stringify(candidateMessage).replace(escaped(effective), escaped(INPUT)),
					JSON.stringify(baselineMessage),
					`${provider} new message with the inserted text removed`,
				);

				// Whole-envelope comparison where the adapter adds no per-session body field.
				if (provider !== "openai") {
					const baselineBody = transport.requests.at(-2)?.body ?? "";
					const candidateBody = transport.requests.at(-1)?.body ?? "";
					assertSameSerialized(
						candidateBody.replace(escaped(effective), escaped(INPUT)),
						baselineBody,
						`${provider} serialized body with the inserted text removed`,
					);
				}

				const candidateSecond = providerBody(provider, await sendTurn(candidate.session, transport, SECOND_INPUT));
				assertSameSerialized(
					comparableItems(candidateSecond.items.slice(0, candidateFirst.items.length)),
					comparableItems(candidateFirst.items),
					`${provider} later request repeats the decorated message identically`,
				);
				if (provider === "anthropic") {
					assert.notEqual(
						JSON.stringify(candidateSecond.items[0]),
						JSON.stringify(candidateFirst.items[0]),
						"a later request adds cache_control annotations to earlier messages",
					);
				}

				const sessionFile = candidateManager.getSessionFile();
				assert.ok(sessionFile, "session file exists");
				const reopenedFile = `${sessionFile}.reopened`;
				await copyFile(sessionFile, reopenedFile);
				const reopened = await open({
					sessionManager: SessionManager.open(reopenedFile),
					runtime,
					model: { providerId, modelId },
					extensionFactories: [createPushContractFixture()],
				});
				const reopenedBody = providerBody(provider, await sendTurn(reopened.session, transport, SECOND_INPUT));
				assertSameSerialized(
					comparableItems(reopenedBody.items.slice(0, candidateFirst.items.length)),
					comparableItems(candidateFirst.items),
					`${provider} reopened request repeats the decorated message identically`,
				);
			});
		});
	}
});
