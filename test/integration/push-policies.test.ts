/**
 * The three policies the real runner has to prove: a model change
 * picks up the binding of the new model, `PI_SUBAGENT_CHILD` selects the
 * subagent policy, and compaction adds no decoration of its own.
 *
 * Each case asserts what was sent and what the branch recorded. A cache
 * comparison belongs to `cache-prefix.test.ts`; this file only establishes the
 * behaviour those comparisons then measure.
 */

import "../support/pinned-pi-package.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	SYNTHETIC_MODEL_ID,
	SYNTHETIC_OPENAI_MODEL_ID,
} from "../support/isolated-session.ts";
import {
	appliedEntries,
	branchStateEntries,
	countOccurrences,
	effectiveText,
	escaped,
	itemText,
	PREFIX,
	requestView,
	sendTurn,
	SUFFIX,
	userMessages,
	withPushHarness,
} from "../support/push-harness.ts";

const INPUT = "Synthetic policy input.";
const SECOND_INPUT = "Synthetic second policy input.";
const SONNET_PREFIX = "SYNTHETIC-SONNET-BEFORE";
const GPT_PREFIX = "SYNTHETIC-GPT-BEFORE";

type SessionModel = NonNullable<AgentSession["model"]>;

function openaiModel(session: Pick<AgentSession, "modelRuntime">): SessionModel {
	const model = session.modelRuntime.getModel(
		"openai",
		SYNTHETIC_OPENAI_MODEL_ID,
	);
	assert.ok(model, `the harness offers openai/${SYNTHETIC_OPENAI_MODEL_ID}`);
	return model;
}

describe("push-prompts: a model change uses the binding of the new model", () => {
	it("applies the next model's binding and leaves the earlier send alone", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "sonnet", { prepend: SONNET_PREFIX });
			await harness.writeProfile("global", "gpt", { prepend: GPT_PREFIX });
			await harness.writeConfig("global", {
				bindings: [
					{
						id: "sonnet",
						profile: "global:sonnet",
						match: [{ provider: "anthropic", model: SYNTHETIC_MODEL_ID }],
					},
					{
						id: "gpt",
						profile: "global:gpt",
						match: [{ provider: "openai", model: SYNTHETIC_OPENAI_MODEL_ID }],
					},
				],
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
			const first = appliedEntries(manager).at(-1);
			assert.equal(first?.profile, "global:sonnet");
			assert.equal(first?.provider, "anthropic");

			await opened.session.setModel(openaiModel(opened.session));
			const body = await sendTurn(opened.session, harness.transport, SECOND_INPUT);

			const second = appliedEntries(manager).at(-1);
			assert.equal(second?.profile, "global:gpt", "the new model's binding applies");
			assert.equal(second?.provider, "openai");
			assert.equal(second?.model, SYNTHETIC_OPENAI_MODEL_ID);
			assert.equal(appliedEntries(manager).length, 2, "one record per send");

			const items = requestView("openai", body).items;
			assert.equal(
				itemText("openai", items.at(-1)),
				effectiveText(SECOND_INPUT, { prepend: GPT_PREFIX }),
				"the new message carries the new binding's text",
			);
			assert.equal(
				countOccurrences(body, escaped(effectiveText(INPUT, { prepend: SONNET_PREFIX }))),
				1,
				"the earlier send keeps the text it was sent with",
			);
			assert.equal(
				countOccurrences(body, escaped(GPT_PREFIX)),
				1,
				"the new binding's text appears once",
			);
		});
	});
});

describe("push-prompts: subagent policy", () => {
	it("adds nothing when the policy is off, even with a selection and a binding", async () => {
		await withPushHarness(
			async (harness) => {
				await harness.writeProfile("global", "base", { prepend: PREFIX });
				await harness.writeConfig("global", {
					subagents: "off",
					selection: { mode: "manual", profile: "global:base" },
					bindings: [
						{
							id: "all",
							profile: "global:base",
							match: [{ model: "*" }],
						},
					],
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
				assert.equal(
					itemText("anthropic", requestView("anthropic", body).items.at(-1)),
					INPUT,
					"the message is sent as written",
				);
				assert.deepEqual(appliedEntries(manager), []);
			},
			{},
			{ subagent: true },
		);
	});

	it("uses only an explicit binding when the policy is bindings", async () => {
		await withPushHarness(
			async (harness) => {
				await harness.writeProfile("global", "base", { prepend: PREFIX });
				await harness.writeProfile("global", "child", { append: SUFFIX });
				await harness.writeConfig("global", {
					subagents: "bindings",
					selection: { mode: "manual", profile: "global:base" },
					defaultProfile: "global:base",
					bindings: [
						{
							id: "child",
							profile: "global:child",
							match: [{ provider: "anthropic", model: SYNTHETIC_MODEL_ID }],
						},
					],
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
				assert.equal(
					itemText("anthropic", requestView("anthropic", body).items.at(-1)),
					effectiveText(INPUT, { append: SUFFIX }),
					"the binding decides, not the session selection or the default",
				);
				assert.equal(appliedEntries(manager).at(-1)?.profile, "global:child");
			},
			{},
			{ subagent: true },
		);
	});

	it("ignores the default profile under the bindings policy when no binding matches", async () => {
		await withPushHarness(
			async (harness) => {
				await harness.writeProfile("global", "base", { prepend: PREFIX });
				await harness.writeConfig("global", {
					subagents: "bindings",
					defaultProfile: "global:base",
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
				assert.equal(
					itemText("anthropic", requestView("anthropic", body).items.at(-1)),
					INPUT,
					"no binding matched, so nothing is added",
				);
				assert.deepEqual(appliedEntries(manager), []);
			},
			{},
			{ subagent: true },
		);
	});

	it("resolves normally, including the default, when the policy is inherit", async () => {
		await withPushHarness(
			async (harness) => {
				await harness.writeProfile("global", "base", {
					prepend: PREFIX,
					append: SUFFIX,
				});
				await harness.writeConfig("global", {
					subagents: "inherit",
					defaultProfile: "global:base",
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
				assert.equal(
					itemText("anthropic", requestView("anthropic", body).items.at(-1)),
					effectiveText(INPUT, { prepend: PREFIX, append: SUFFIX }),
					"the default profile applies as it would outside a subagent",
				);
			},
			{},
			{ subagent: true },
		);
	});
});

describe("push-prompts: compaction with the extension loaded", () => {
	it("decorates no summary, keeps the stored messages and leaves once armed", async () => {
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
				settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			});
			assert.ok(opened.runtime);

			await sendTurn(opened.session, harness.transport, INPUT);
			await sendTurn(opened.session, harness.transport, SECOND_INPUT);
			await sendTurn(opened.session, harness.transport, "Synthetic policy input three.");
			await sendTurn(opened.session, harness.transport, "Synthetic policy input four.");
			opened.runtime.armOnce("global:base");
			const stored = userMessages(manager).map((entry) => entry.text);
			assert.equal(appliedEntries(manager).length, 4);

			await opened.session.compact();

			assert.equal(
				appliedEntries(manager).length,
				4,
				"the compaction summary is not a user message and was not decorated",
			);
			assert.deepEqual(
				userMessages(manager).map((entry) => entry.text),
				stored,
				"the stored user message keeps its exact text",
			);
			assert.equal(
				branchStateEntries(manager).at(-1)?.once,
				"global:base",
				"compaction consumed nothing",
			);

			const body = await sendTurn(opened.session, harness.transport, SECOND_INPUT);
			const items = requestView("anthropic", body).items;
			assert.equal(
				itemText("anthropic", items.at(-1)),
				effectiveText(SECOND_INPUT, { prepend: PREFIX, append: SUFFIX }),
				"the new message carries the inserted text once",
			);
			// Compaction decides how much of the history survives; whatever it keeps
			// must still carry its own text and nothing more.
			const decoratedInRequest = items.filter((item) =>
				(itemText("anthropic", item) ?? "").includes(PREFIX),
			).length;
			assert.ok(decoratedInRequest >= 1, "the request still carries a decorated message");
			assert.equal(
				countOccurrences(body, escaped(PREFIX)),
				decoratedInRequest,
				"the prefix appears once per decorated message and nowhere else",
			);
			assert.equal(
				appliedEntries(manager).length,
				5,
				"the send after compaction was decorated exactly once",
			);
		});
	});
});
