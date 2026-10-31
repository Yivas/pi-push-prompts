/**
 * Behaviour of the production extension through the real Pi runner: what is
 * decorated, when `once` is consumed or disarmed, what a rejected send does to
 * the text, and what the presentation layer paints.
 *
 * The outbound transport is simulated; everything else is the Pi version this
 * repository pins. TUI painting itself is not exercised (no TTY): the renderer
 * and the Markdown transformer are called through the public runner, which is
 * exactly what the interactive mode calls.
 */

import "../support/pinned-pi-package.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type ExtensionFactory,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { APPLIED_ENTRY_TYPE } from "../../src/core/applied.ts";
import {
	createOtherDecoratorFixture,
	OTHER_APPEND,
	OTHER_PREPEND,
} from "../fixtures/push-contract-fixture.ts";
import {
	appliedEntries,
	branchAppliedEntries,
	branchStateEntries,
	countOccurrences,
	effectiveText,
	itemText,
	PREFIX,
	requestView,
	sendTurn,
	SEPARATOR,
	stateEntries,
	SUFFIX,
	userMessages,
	withPushHarness,
} from "../support/push-harness.ts";
import {
	syntheticAnthropicToolCallStream,
	syntheticErrorResponse,
} from "../support/synthetic-transport.ts";

const INPUT = "Synthetic push input.";
const SECOND_INPUT = "Synthetic second push input.";
const TOOL_INPUT = "Synthetic tool push input.";
const TOOL_FILE_TEXT = "Synthetic tool file body.";
const ONCE = "global:once";
const ONCE_PREFIX = "SYNTHETIC-ONCE-BEFORE";

interface SenderFixtureOptions {
	readonly steerCommand: string;
	readonly followUpCommand: string;
	readonly idleCommand: string;
}

/** Test-only commands that make Pi send user messages through the public API. */
function createSenderFixture(options: SenderFixtureOptions): ExtensionFactory {
	return (pi) => {
		const entries: Array<[string, string, "steer" | "followUp" | undefined]> = [
			[options.steerCommand, "Synthetic steer message.", "steer"],
			[options.followUpCommand, "Synthetic follow-up message.", "followUp"],
			[options.idleCommand, "Synthetic idle message.", undefined],
		];
		for (const [name, text, deliverAs] of entries) {
			pi.registerCommand(name, {
				description: `Test-only: send "${text}"`,
				handler: async () => {
					pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
				},
			});
		}
	};
}

const SENDER = createSenderFixture({
	steerCommand: "push-test-steer",
	followUpCommand: "push-test-follow-up",
	idleCommand: "push-test-idle",
});

function userEntryId(sessionManager: SessionManager, index: number): string {
	const ids = sessionManager.getEntries().flatMap((entry: SessionEntry) => {
		if (entry.type !== "message" || entry.message.role !== "user") {
			return [];
		}
		return [entry.id];
	});
	const id = ids[index];
	assert.ok(id, `user message ${index} exists`);
	return id;
}

describe("push-prompts: decorating a finalized user message", () => {
	it("inserts the selected profile once and records the exact text it added", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", {
				prepend: PREFIX,
				append: SUFFIX,
			});
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			const body = await sendTurn(opened.session, harness.transport, INPUT);
			const effective = effectiveText(INPUT, { prepend: PREFIX, append: SUFFIX });

			const view = requestView("anthropic", body);
			assert.equal(itemText("anthropic", view.items.at(-1)), effective, "request carries the effective text");
			assert.deepEqual(
				userMessages(manager).map((message) => message.text),
				[effective],
				"the persisted user message is the effective one",
			);

			const entries = appliedEntries(manager);
			assert.equal(entries.length, 1, "one applied entry");
			assert.equal(entries[0]?.profile, "global:base");
			assert.equal(entries[0]?.mode, "active");
			assert.equal(entries[0]?.insertedPrefix, `${PREFIX}${SEPARATOR}`);
			assert.equal(entries[0]?.insertedSuffix, `${SEPARATOR}${SUFFIX}`);
			assert.equal(entries[0]?.shape.content, "array");
			assert.equal(entries[0]?.shape.prefix, "merged");
			assert.equal(entries[0]?.provider, "anthropic");
			assert.equal(entries[0]?.model, "claude-sonnet-4-5");
			assert.equal(
				entries[0]?.timestamp,
				userMessages(manager)[0]?.timestamp,
				"the entry is tied to the message by timestamp",
			);
		});
	});

	it("applies append-only, prepend-only and inherited text literally", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "root", { prepend: "ROOT-BEFORE" });
			await harness.writeProfile("global", "child", {
				prepend: "CHILD-BEFORE",
				append: "CHILD-AFTER",
			});
			await harness.writeConfig("global", {
				profiles: { child: { extends: "global:root" } },
				selection: { mode: "manual", profile: "global:child" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			await sendTurn(opened.session, harness.transport, INPUT);

			assert.equal(
				userMessages(manager)[0]?.text,
				effectiveText(INPUT, {
					prepend: `ROOT-BEFORE${SEPARATOR}CHILD-BEFORE`,
					append: "CHILD-AFTER",
				}),
				"inheritance joins the root first and keeps each side apart",
			);
		});
	});

	it("leaves the message untouched and records nothing when no profile applies", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", { selection: { mode: "off" } });
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			const body = await sendTurn(opened.session, harness.transport, INPUT);

			assert.equal(itemText("anthropic", requestView("anthropic", body).items.at(-1)), INPUT);
			assert.deepEqual(appliedEntries(manager), []);
			assert.deepEqual(stateEntries(manager), [], "no state was written either");
		});
	});

	it("repeats the stored history without decorating it again after reopen", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			await sendTurn(opened.session, harness.transport, INPUT);
			const file = manager.getSessionFile();
			assert.ok(file, "the session file exists");

			const reopenedManager = SessionManager.open(file);
			const reopened = await harness.open({
				sessionManager: reopenedManager,
				projectTrusted: false,
			});
			const body = await sendTurn(
				reopened.session,
				harness.transport,
				SECOND_INPUT,
			);

			const first = effectiveText(INPUT, { prepend: PREFIX });
			assert.deepEqual(
				userMessages(reopenedManager).map((message) => message.text),
				[first, effectiveText(SECOND_INPUT, { prepend: PREFIX })],
				"history keeps its effective text and only the new message was decorated",
			);
			assert.equal(
				countOccurrences(harness.transport.requests.at(-1)?.body ?? "", PREFIX),
				2,
				"one prefix per decorated message, none added to history",
			);
			assert.equal(
				requestView("anthropic", body).items.length,
				3,
				"two user messages and the reply to the first: the new reply does not exist yet",
			);
			assert.equal(appliedEntries(reopenedManager).length, 2);
		});
	});
});

describe("push-prompts: once", () => {
	it("consumes once for the finalized message and falls back afterwards", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "once", { prepend: ONCE_PREFIX });
			await harness.writeConfig("global", { selection: { mode: "off" } });
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			assert.ok(opened.runtime, "the extension exposed its runtime");
			opened.runtime.armOnce(ONCE);
			assert.equal(stateEntries(manager).at(-1)?.once, ONCE, "armed on the branch");

			await sendTurn(opened.session, harness.transport, INPUT);
			await sendTurn(opened.session, harness.transport, SECOND_INPUT);

			assert.deepEqual(
				userMessages(manager).map((message) => message.text),
				[effectiveText(INPUT, { prepend: ONCE_PREFIX }), SECOND_INPUT],
				"once applied to one message only",
			);
			const entries = appliedEntries(manager);
			assert.equal(entries.length, 1);
			assert.equal(entries[0]?.mode, "once");
			assert.equal(stateEntries(manager).at(-1)?.once, undefined, "once was cleared");
		});
	});

	it("consumes once for the delivered message while a queued message is cleared", async () => {
		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		await withPushHarness(
			async (harness) => {
				await harness.writeProfile("global", "once", { prepend: ONCE_PREFIX });
				await harness.writeConfig("global", { selection: { mode: "off" } });
				const manager = SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				);
				const opened = await harness.open({
					sessionManager: manager,
					projectTrusted: false,
					tools: [],
				});
				assert.ok(opened.runtime);
				opened.runtime.armOnce(ONCE);

				const first = opened.session.prompt(INPUT);
				await waitFor(() => harness.transport.requests.length === 1);
				await opened.session.prompt("Synthetic queued input.", {
					streamingBehavior: "followUp",
				});
				const cleared = opened.session.clearQueue();
				assert.equal(cleared.followUp.length, 1, "the follow-up was queued and cleared");
				release();
				await first;

				assert.equal(harness.transport.requests.length, 1, "the cleared message was never sent");
				assert.equal(
					stateEntries(manager).at(-1)?.once,
					undefined,
					"the delivered message consumed once",
				);
				assert.equal(appliedEntries(manager).length, 1, "only the first message was decorated");
			},
			{
				beforeResponse: async (index) => {
					if (index === 0) {
						await hold;
					}
				},
			},
		);
	});

	it("keeps once armed when a queued message is cleared before its message_end", async () => {
		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		await withPushHarness(
			async (harness) => {
				await harness.writeProfile("global", "once", { prepend: ONCE_PREFIX });
				await harness.writeConfig("global", { selection: { mode: "off" } });
				const manager = SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				);
				const opened = await harness.open({
					sessionManager: manager,
					projectTrusted: false,
					tools: [],
				});
				assert.ok(opened.runtime);

				// Occupy the queue first: the first request is held at the transport
				// boundary, so the follow-up below is queued and not yet finalized.
				const first = opened.session.prompt(INPUT);
				await waitFor(() => harness.transport.requests.length === 1);
				await opened.session.prompt("Synthetic queued input.", {
					streamingBehavior: "followUp",
				});
				opened.runtime.armOnce(ONCE);
				const cleared = opened.session.clearQueue();
				assert.equal(
					cleared.followUp.length,
					1,
					"the follow-up was queued and cleared before its message_end",
				);
				release();
				await first;

				assert.equal(harness.transport.requests.length, 1, "the cleared message was never sent");
				assert.equal(
					stateEntries(manager).at(-1)?.once,
					ONCE,
					"clearing the queue did not consume once",
				);
				assert.deepEqual(
					appliedEntries(manager).map((entry) => entry.profile),
					[],
					"the cleared message was not decorated, and the first one had no profile",
				);

				await sendTurn(opened.session, harness.transport, SECOND_INPUT);
				assert.deepEqual(
					userMessages(manager).map((message) => message.text),
					[INPUT, effectiveText(SECOND_INPUT, { prepend: ONCE_PREFIX })],
					"the next delivered message is the one that uses the armed profile",
				);
				assert.equal(
					stateEntries(manager).at(-1)?.once,
					undefined,
					"that message consumed once",
				);
			},
			{
				beforeResponse: async (index) => {
					if (index === 0) {
						await hold;
					}
				},
			},
		);
	});

	it("keeps once armed and the text in the editor when the pre-check stops the send", async () => {
		await withPushHarness(async (harness) => {
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			assert.ok(opened.runtime);
			opened.runtime.armOnce("global:missing");

			await opened.session.prompt(INPUT);

			assert.equal(harness.transport.requests.length, 0, "nothing was sent");
			assert.equal(appliedEntries(manager).length, 0, "nothing was decorated");
			assert.deepEqual(opened.editorTexts, [INPUT], "the text went back to the editor");
			assert.equal(opened.notices.length, 1, "the user was told why");
			assert.match(opened.notices[0]?.message ?? "", /profile/i);
			assert.doesNotMatch(
				opened.notices[0]?.message ?? "",
				new RegExp(PREFIX),
				"the diagnostic never quotes a profile body",
			);
			assert.equal(stateEntries(manager).at(-1)?.once, "global:missing", "once stayed armed");
		});
	});

	it("drops once from the branch when the tree moves to an earlier point", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "once", { prepend: ONCE_PREFIX });
			await harness.writeConfig("global", { selection: { mode: "off" } });
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			assert.ok(opened.runtime);
			await sendTurn(opened.session, harness.transport, INPUT);
			await sendTurn(opened.session, harness.transport, SECOND_INPUT);
			opened.runtime.armOnce(ONCE);
			assert.equal(branchStateEntries(manager).at(-1)?.once, ONCE);

			await opened.session.navigateTree(userEntryId(manager, 0));

			// The armed entry was appended after the target of the navigation, so
			// Pi's own branch semantics take it out of the active branch and the
			// extension reads no `once` at all. It stays in the file as history.
			assert.deepEqual(
				branchStateEntries(manager),
				[],
				"the armed entry is no longer on the active branch",
			);
			await sendTurn(opened.session, harness.transport, "Synthetic third input.");
			assert.deepEqual(
				branchAppliedEntries(manager).map((entry) => entry.mode),
				[],
				"the armed profile never fired after the navigation",
			);
		});
	});

	it("does not resurrect once when the tree moves forward over its entry", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "once", { prepend: ONCE_PREFIX });
			await harness.writeConfig("global", { selection: { mode: "off" } });
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			assert.ok(opened.runtime);
			await sendTurn(opened.session, harness.transport, INPUT);
			opened.runtime.armOnce(ONCE);
			const armedLeaf = manager.getLeafId();
			assert.ok(armedLeaf, "the armed state entry is the leaf");

			await opened.session.navigateTree(userEntryId(manager, 0));
			await opened.session.navigateTree(armedLeaf);

			// Moving forward puts the armed entry back on the branch, so the
			// extension records the disarm instead of letting it fire later.
			assert.equal(
				branchStateEntries(manager).at(-1)?.once,
				undefined,
				"the branch ends with a disarm entry",
			);
			await sendTurn(opened.session, harness.transport, SECOND_INPUT);
			assert.deepEqual(
				branchAppliedEntries(manager).map((entry) => entry.mode),
				[],
				"the resurrected entry never fired",
			);
		});
	});

	it("disarms once when Pi starts the session for a fork", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "once", { prepend: ONCE_PREFIX });
			await harness.writeConfig("global", { selection: { mode: "off" } });
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			assert.ok(opened.runtime);
			// A fork needs a saved session, and Pi builds it from a real leaf.
			await sendTurn(opened.session, harness.transport, INPUT);
			opened.runtime.armOnce(ONCE);
			const file = manager.getSessionFile();
			assert.ok(file);

			// Pi emits `session_start` with reason "fork" after building the forked
			// file; the option replays that exact event on a real session, which
			// appends to its own manager.
			const forked = await harness.open({
				sessionManager: SessionManager.open(file),
				projectTrusted: false,
				sessionStartReason: "fork",
			});
			const forkedManager = forked.session.sessionManager;
			assert.deepEqual(
				branchStateEntries(forkedManager).map((entry) => entry.once),
				["global:once", undefined],
				"the fork keeps the armed entry and records the disarm after it",
			);
			await sendTurn(forked.session, harness.transport, INPUT);
			assert.deepEqual(
				branchAppliedEntries(forkedManager),
				[],
				"the forked branch sent no armed profile",
			);
		});
	});
});

describe("push-prompts: eligibility and coexistence", () => {
	it("decorates a steer, a follow-up and an extension send exactly once each", async () => {
		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		await withPushHarness(
			async (harness) => {
				await harness.writeProfile("global", "base", { prepend: PREFIX });
				await harness.writeConfig("global", {
					selection: { mode: "manual", profile: "global:base" },
				});
				const manager = SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				);
				const opened = await harness.open({
					sessionManager: manager,
					projectTrusted: false,
					extensionsAfter: [SENDER],
				});

				// Both queued sends are issued while the first request is held at the
				// transport boundary, so Pi delivers them as steer and follow-up.
				const first = opened.session.prompt(INPUT);
				await waitFor(() => harness.transport.requests.length === 1);
				await opened.session.prompt("/push-test-steer");
				await opened.session.prompt("/push-test-follow-up");
				release();
				await first;
				await opened.session.waitForIdle();

				await opened.session.prompt("/push-test-idle");
				// The command hands the message to Pi and returns; the turn starts on its
				// own, so wait for it to be persisted instead of racing it.
				await waitFor(() => userMessages(manager).length === 4);
				await opened.session.waitForIdle();

				const texts = userMessages(manager).map((message) => message.text);
				assert.equal(texts.length, 4, "two queued sends, the first prompt and one idle send");
				assert.deepEqual(
					texts.map((text) => countOccurrences(text, PREFIX)),
					[1, 1, 1, 1],
					"every user message, whoever sent it, carries the prefix once",
				);
				assert.deepEqual(
					branchAppliedEntries(manager).map((entry) => entry.mode),
					["active", "active", "active", "active"],
				);
			},
			{
				beforeResponse: async (index) => {
					if (index === 0) {
						await hold;
					}
				},
			},
		);
	});

	it("does not decorate the continuation after a tool call", async () => {
		await withPushHarness(
			async (harness) => {
				await writeFile(
					join(harness.sandbox.cwd, "synthetic-tool-input.txt"),
					TOOL_FILE_TEXT,
				);
				await harness.writeProfile("global", "base", { prepend: PREFIX });
				await harness.writeConfig("global", {
					selection: { mode: "manual", profile: "global:base" },
				});
				const manager = SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				);
				const opened = await harness.open({
					sessionManager: manager,
					projectTrusted: false,
					tools: ["read"],
				});

				await opened.session.prompt(TOOL_INPUT);

				assert.equal(harness.transport.requests.length, 2, "user turn plus continuation");
				assert.equal(appliedEntries(manager).length, 1, "one decoration for one user message");
				assert.equal(
					countOccurrences(harness.transport.requests[1]?.body ?? "", PREFIX),
					1,
					"the continuation repeats the message unchanged",
				);
			},
			{
				responseFor: (index) =>
					index === 0
						? syntheticAnthropicToolCallStream({
								id: "toolu_push_1",
								name: "read",
								argumentsJson: JSON.stringify({
									path: "synthetic-tool-input.txt",
								}),
							})
						: undefined,
			},
		);
	});

	it("does not decorate twice when an automatic retry repeats the request", async () => {
		await withPushHarness(
			async (harness) => {
				await harness.writeProfile("global", "base", { prepend: PREFIX });
				await harness.writeConfig("global", {
					selection: { mode: "manual", profile: "global:base" },
				});
				const manager = SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				);
				const opened = await harness.open({
					sessionManager: manager,
					projectTrusted: false,
					settings: {
						retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
					},
				});

				await opened.session.prompt(INPUT);

				assert.equal(harness.transport.requests.length, 2, "the first attempt failed and was retried");
				for (const request of harness.transport.requests) {
					assert.equal(countOccurrences(request.body, PREFIX), 1, "one prefix in each attempt");
				}
				assert.equal(appliedEntries(manager).length, 1, "one decoration for the message");
			},
			{
				responseFor: (index) =>
					index === 0
						? syntheticErrorResponse(500, "synthetic server error")
						: undefined,
			},
		);
	});

	it("survives a second extension that also replaces the user message", async () => {
		for (const order of ["push-first", "other-first"] as const) {
			await withPushHarness(async (harness) => {
				await harness.writeProfile("global", "base", { prepend: PREFIX });
				await harness.writeConfig("global", {
					selection: { mode: "manual", profile: "global:base" },
				});
				const manager = SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				);
				const opened = await harness.open({
					sessionManager: manager,
					projectTrusted: false,
					extensionsBefore: order === "other-first" ? [createOtherDecoratorFixture()] : [],
					extensionsAfter: order === "push-first" ? [createOtherDecoratorFixture()] : [],
				});
				await sendTurn(opened.session, harness.transport, INPUT);

				const [message] = userMessages(manager);
				assert.ok(message);
				assert.equal(countOccurrences(message.text, PREFIX), 1, "our text was inserted once");
				assert.equal(countOccurrences(message.text, OTHER_PREPEND), 1, "the other text once");
				assert.equal(appliedEntries(manager).length, 1, "we recorded exactly one decoration");
				assert.ok(opened.runtime);
				const [view] = opened.runtime.listApplied(1);
				assert.ok(view, "the decoration is listed");
				if (order === "push-first") {
					assert.equal(view.intact, false, "a later replacement invalidates our digest");
					assert.equal(view.original, undefined);
				} else {
					assert.equal(view.intact, true, "a replacement before ours is part of the original");
					assert.equal(
						view.original,
						effectiveText(INPUT, {
							prepend: OTHER_PREPEND,
							append: OTHER_APPEND,
						}),
					);
				}
			});
		}
	});

	it("ignores an untrusted project and applies it once trusted", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("project", "p", { prepend: "PROJECT-BEFORE" });
			await harness.writeConfig("project", {
				selection: { mode: "manual", profile: "project:p" },
			});

			const untrustedManager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const untrusted = await harness.open({
				sessionManager: untrustedManager,
				projectTrusted: false,
			});
			await sendTurn(untrusted.session, harness.transport, INPUT);
			assert.deepEqual(
				userMessages(untrustedManager).map((message) => message.text),
				[INPUT],
				"project state is not read without trust",
			);

			const trustedManager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const trusted = await harness.open({
				sessionManager: trustedManager,
				projectTrusted: true,
			});
			await sendTurn(trusted.session, harness.transport, INPUT);
			assert.deepEqual(
				userMessages(trustedManager).map((message) => message.text),
				[effectiveText(INPUT, { prepend: "PROJECT-BEFORE" })],
				"a trusted project applies its own profile",
			);
		});
	});
});

describe("push-prompts: presentation", () => {
	it("draws the Push row only in the added mode and reads display at paint time", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			await sendTurn(opened.session, harness.transport, INPUT);
			assert.ok(opened.runtime);

			const runner = opened.session.extensionRunner;
			const renderer = runner.getEntryRenderer(APPLIED_ENTRY_TYPE);
			assert.ok(renderer, "the entry renderer is registered");
			const entry = manager
				.getEntries()
				.find((item) => item.type === "custom" && item.customType === APPLIED_ENTRY_TYPE);
			assert.ok(entry && entry.type === "custom", "the applied entry exists");

			assert.equal(
				renderer(entry, { expanded: false }, runner.getUIContext().theme),
				undefined,
				"hidden draws no row at all",
			);

			opened.runtime.setDisplay("global", "added");
			const component = renderer(entry, { expanded: false }, runner.getUIContext().theme);
			assert.ok(component, "added draws a row");
			const lines = component.render(80);
			assert.match(lines[0] ?? "", /push-prompts: global:base \(active\)/);
			assert.ok(lines.includes(PREFIX), "the added prefix is shown");
		});
	});

	it("paints the original text in the native row after reopen", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX, append: SUFFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			await sendTurn(opened.session, harness.transport, INPUT);
			const file = manager.getSessionFile();
			assert.ok(file);

			const reopenedManager = SessionManager.open(file);
			const reopened = await harness.open({
				sessionManager: reopenedManager,
				projectTrusted: false,
			});
			const [transformer] = reopened.session.extensionRunner.getMarkdownTransformers();
			assert.ok(transformer, "the transformer is registered");
			const stored = userMessages(reopenedManager)[0]?.text;
			assert.ok(stored);

			assert.equal(
				transformer(stored, { messageType: "user", isStreaming: false, availableWidth: 80 }),
				INPUT,
				"the row paints the original",
			);
			assert.equal(
				transformer("Unrelated text.", {
					messageType: "user",
					isStreaming: false,
					availableWidth: 80,
				}),
				"Unrelated text.",
				"unknown text is returned unchanged",
			);
		});
	});

	it("leaves the native row unchanged when the stored text is also another message's original", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			await sendTurn(opened.session, harness.transport, INPUT);
			const firstEffective = effectiveText(INPUT, { prepend: PREFIX });
			// The second message is sent as the first message's effective text, so
			// that text is both a stored message and a recorded original.
			await sendTurn(opened.session, harness.transport, firstEffective);
			const file = manager.getSessionFile();
			assert.ok(file);

			const reopenedManager = SessionManager.open(file);
			const reopened = await harness.open({
				sessionManager: reopenedManager,
				projectTrusted: false,
			});
			const [transformer] = reopened.session.extensionRunner.getMarkdownTransformers();
			assert.ok(transformer);
			const messages = userMessages(reopenedManager);
			assert.equal(messages.length, 2);

			assert.equal(
				transformer(messages[0]?.text ?? "", {
					messageType: "user",
					isStreaming: false,
					availableWidth: 80,
				}),
				messages[0]?.text,
				"the text is ambiguous, so it stays exactly as painted",
			);
			assert.equal(
				transformer(messages[1]?.text ?? "", {
					messageType: "user",
					isStreaming: false,
					availableWidth: 80,
				}),
				firstEffective,
				"the second message maps back to the text it was sent with",
			);
		});
	});

	it("lists the last decorated messages with original and effective text", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			await sendTurn(opened.session, harness.transport, INPUT);
			await sendTurn(opened.session, harness.transport, SECOND_INPUT);
			assert.ok(opened.runtime);

			const views = opened.runtime.listApplied(2);
			assert.deepEqual(
				views.map((view) => [view.original, view.effective]),
				[
					[INPUT, effectiveText(INPUT, { prepend: PREFIX })],
					[SECOND_INPUT, effectiveText(SECOND_INPUT, { prepend: PREFIX })],
				],
			);
			assert.equal(opened.runtime.listApplied(1).length, 1, "newest first page");
		});
	});
});

/** Polls until `check` passes; the harness has no event for "the request arrived". */
async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (check()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not met in time");
}
