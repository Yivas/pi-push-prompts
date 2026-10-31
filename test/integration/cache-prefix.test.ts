/**
 * The cache contract, per provider, against Pi without the extension.
 *
 * Baseline for every measured send: a copy of the candidate's saved session,
 * opened with no extension at all, sending the same new message. The candidate
 * runs the real extension. The two serialized bodies must be byte-identical
 * except for the text inserted into the new message; anything else is a
 * failure, not a characterization. The only field excluded anywhere is OpenAI's
 * `prompt_cache_key`, and only after asserting that both bodies carry the same
 * value for the same session file.
 *
 * Nothing is stripped or normalized to make a comparison pass. A mismatch
 * reports digests, lengths and the first differing index, never a body.
 */

import "../support/pinned-pi-package.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { APPLIED_ENTRY_TYPE } from "../../src/core/applied.ts";
import type { Runtime } from "../../src/index.ts";
import {
	SYNTHETIC_GOOGLE_MODEL_ID,
	SYNTHETIC_MODEL_ID,
	SYNTHETIC_OPENAI_MODEL_ID,
	SYNTHETIC_PROVIDER_ID,
} from "../support/isolated-session.ts";
import {
	PREFIX,
	type OpenedSession,
	type PushHarness,
	SEPARATOR,
	ScriptedUI,
	SUFFIX,
	appliedEntries,
	assertSameSerialized,
	countOccurrences,
	effectiveText,
	escaped,
	requestView,
	sendTurn,
	stateEntries,
	userMessages,
	withPushHarness,
} from "../support/push-harness.ts";
import type { SyntheticProvider } from "../support/synthetic-transport.ts";

const INPUT = "Synthetic cache probe one.";
const SECOND_INPUT = "Synthetic cache probe two.";
const THIRD_INPUT = "Synthetic cache probe three.";
const FOURTH_INPUT = "Synthetic cache probe four.";
const FIFTH_INPUT = "Synthetic cache probe five.";
const SIXTH_INPUT = "Synthetic cache probe six.";
const ROOT_PREFIX = "SYNTHETIC-ROOT-BEFORE";
const CHILD_PREFIX = "SYNTHETIC-CHILD-BEFORE";
const CHILD_SUFFIX = "SYNTHETIC-CHILD-AFTER";
const EDIT_PREFIX = "SYNTHETIC-EDIT-BEFORE";
const OTHER_PREFIX = "SYNTHETIC-OTHER-BEFORE";
const SWITCH_PREFIX = "SYNTHETIC-SWITCH-BEFORE";

/** The provider a model switch moves to, so each provider measures one switch. */
const NEXT_PROVIDER: Record<SyntheticProvider, SyntheticProvider> = {
	anthropic: "openai",
	openai: "google",
	google: "anthropic",
};

interface ProviderCase {
	readonly provider: SyntheticProvider;
	readonly providerId: string;
	readonly modelId: string;
}

interface MeasuredTurn {
	readonly harness: PushHarness;
	readonly provider: SyntheticProvider;
	readonly session: AgentSession;
	readonly text: string;
	/** Inserted text the extension is expected to add, or undefined for none. */
	readonly inserted?: { readonly prepend?: string; readonly append?: string };
	/**
	 * Thinking level of the candidate, so the baseline is built in the same state.
	 * A model switch can change it, and the adapters serialize it.
	 */
	readonly thinkingLevel?: AgentSession["thinkingLevel"];
	readonly label: string;
}

let baselineCounter = 0;

/**
 * Sends the same new message through Pi alone (on a copy of the candidate's
 * saved session) and through the candidate, then compares the raw bodies.
 */
async function assertTurnKeepsCache(turn: MeasuredTurn): Promise<void> {
	const { harness, provider, session, text } = turn;
	const manager = session.sessionManager;
	const sessionFile = manager.getSessionFile();
	// Pi writes the session file with the first persisted message. Before that
	// the history is empty, and a fresh plugin-free session is the same history.
	const saved = sessionFile !== undefined && existsSync(sessionFile);
	baselineCounter += 1;
	const baseline = await harness.open({
		sessionManager: saved
			? SessionManager.open(
					await harness.copySession(manager, `baseline-${baselineCounter}`),
				)
			: SessionManager.create(harness.sandbox.cwd, harness.sandbox.sessionDir),
		withExtension: false,
		model: modelOf(provider),
		projectTrusted: false,
		thinkingLevel: turn.thinkingLevel,
	});
	const baselineBody = await sendTurn(baseline.session, harness.transport, text);
	const candidateBody = await sendTurn(session, harness.transport, text);

	// OpenAI stamps the session id into the body. It is the same string for a
	// copy of the same file and a different one for a fresh session, so it is
	// checked against each side's own session and only excluded when the
	// baseline is a different session rather than the same file.
	let candidate: string = candidateBody;
	let baselineComparable: string = baselineBody;
	if (provider === "openai") {
		const keys = assertPromptCacheKey(
			candidateBody,
			baselineBody,
			manager.getSessionId(),
			baseline.session.sessionManager.getSessionId(),
			turn.label,
		);
		if (keys !== undefined && !saved) {
			candidate = withoutPromptCacheKey(candidate, keys.candidate);
			baselineComparable = withoutPromptCacheKey(
				baselineComparable,
				keys.baseline,
			);
		}
	}

	if (!turn.inserted) {
		assertSameSerialized(candidate, baselineComparable, `${turn.label}: body`);
		return;
	}
	const effective = effectiveText(text, turn.inserted);
	assert.equal(
		countOccurrences(candidate, escaped(effective)),
		1,
		`${turn.label}: the effective text appears exactly once in the request`,
	);
	assertSameSerialized(
		candidate.replace(escaped(effective), escaped(text)),
		baselineComparable,
		`${turn.label}: body with only the new message's inserted text removed`,
	);
}

function modelOf(provider: SyntheticProvider): {
	readonly providerId: string;
	readonly modelId: string;
} {
	const cases: Record<SyntheticProvider, { providerId: string; modelId: string }> = {
		anthropic: { providerId: SYNTHETIC_PROVIDER_ID, modelId: SYNTHETIC_MODEL_ID },
		openai: { providerId: "openai", modelId: SYNTHETIC_OPENAI_MODEL_ID },
		google: { providerId: "google", modelId: SYNTHETIC_GOOGLE_MODEL_ID },
	};
	return cases[provider];
}

interface PromptCacheKeys {
	readonly candidate: string;
	readonly baseline: string;
}

/**
 * `prompt_cache_key` is the session id the adapter clamps into the body, so it
 * proves identity of the session, not a choice the extension could influence.
 */
function assertPromptCacheKey(
	candidateBody: string,
	baselineBody: string,
	candidateSessionId: string,
	baselineSessionId: string,
	label: string,
): PromptCacheKeys | undefined {
	const candidate = requestView("openai", candidateBody).parsed.prompt_cache_key;
	const baseline = requestView("openai", baselineBody).parsed.prompt_cache_key;
	if (typeof candidate !== "string" || typeof baseline !== "string") {
		return undefined;
	}
	assert.equal(
		candidate,
		candidateSessionId,
		`${label}: prompt_cache_key is the candidate session id`,
	);
	assert.equal(
		baseline,
		baselineSessionId,
		`${label}: prompt_cache_key is the baseline session id`,
	);
	return { candidate, baseline };
}

/** Removes one exact serialized field; both bodies are handled the same way. */
function withoutPromptCacheKey(body: string, key: string): string {
	const field = `"prompt_cache_key":${JSON.stringify(key)}`;
	assert.equal(
		countOccurrences(body, field),
		1,
		"prompt_cache_key appears exactly once in the body",
	);
	return body.replace(field, "");
}

function runtimeOf(opened: OpenedSession): Runtime {
	assert.ok(opened.runtime, "the extension exposed its runtime");
	return opened.runtime;
}

/** Body of the most recent provider request, which is the candidate's. */
function lastBody(harness: PushHarness): string {
	const request = harness.transport.requests.at(-1);
	assert.ok(request, "a request was captured");
	return request.body;
}

function testProvider(providerCase: ProviderCase): void {
	const { provider } = providerCase;
	const model = { providerId: providerCase.providerId, modelId: providerCase.modelId };

	it("off and unmatched profiles send the plugin-free body and record nothing", async () => {
		await withPushHarness(async (harness) => {
			const emptyManager = SessionManager.create(harness.sandbox.cwd, harness.sandbox.sessionDir);
			const empty = await harness.open({
				sessionManager: emptyManager,
				model,
				projectTrusted: false,
			});
			await assertTurnKeepsCache({
				harness,
				provider,
				session: empty.session,
				text: INPUT,
				label: "no config",
			});
			assert.deepEqual(appliedEntries(emptyManager), [], "nothing was applied");
			assert.deepEqual(stateEntries(emptyManager), [], "nothing was stored");

			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", { selection: { mode: "off" } });
			const offManager = SessionManager.create(harness.sandbox.cwd, harness.sandbox.sessionDir);
			const off = await harness.open({
				sessionManager: offManager,
				model,
				projectTrusted: false,
			});
			await assertTurnKeepsCache({
				harness,
				provider,
				session: off.session,
				text: SECOND_INPUT,
				label: "selection off",
			});
			assert.deepEqual(appliedEntries(offManager), [], "off applied nothing");
		});
	});

	it("prepend, append, both and inherited profiles add only their own text", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "before", { prepend: PREFIX });
			await harness.writeProfile("global", "after", { append: SUFFIX });
			await harness.writeProfile("global", "both", { prepend: PREFIX, append: SUFFIX });
			await harness.writeProfile("global", "root", { prepend: ROOT_PREFIX });
			await harness.writeProfile("global", "child", {
				prepend: CHILD_PREFIX,
				append: CHILD_SUFFIX,
			});
			await harness.writeConfig("global", {
				profiles: { child: { extends: "global:root" } },
				selection: { mode: "manual", profile: "global:both" },
			});
			const manager = SessionManager.create(harness.sandbox.cwd, harness.sandbox.sessionDir);
			const opened = await harness.open({ sessionManager: manager, model, projectTrusted: false });
			const runtime = runtimeOf(opened);

			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: INPUT,
				inserted: { prepend: PREFIX, append: SUFFIX },
				label: "both sides",
			});

			runtime.setSelection({ mode: "manual", profile: "global:before" });
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: SECOND_INPUT,
				inserted: { prepend: PREFIX },
				label: "prepend only",
			});

			runtime.setSelection({ mode: "manual", profile: "global:after" });
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: THIRD_INPUT,
				inserted: { append: SUFFIX },
				label: "append only",
			});

			runtime.setSelection({ mode: "manual", profile: "global:child" });
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: FOURTH_INPUT,
				inserted: {
					prepend: `${ROOT_PREFIX}${SEPARATOR}${CHILD_PREFIX}`,
					append: CHILD_SUFFIX,
				},
				label: "inherited text",
			});

			// Every earlier send keeps the text it was sent with.
			const body = lastBody(harness);
			for (const [text, inserted] of [
				[INPUT, { prepend: PREFIX, append: SUFFIX }],
				[SECOND_INPUT, { prepend: PREFIX }],
				[THIRD_INPUT, { append: SUFFIX }],
				[FOURTH_INPUT, { prepend: `${ROOT_PREFIX}${SEPARATOR}${CHILD_PREFIX}`, append: CHILD_SUFFIX }],
			] as const) {
				assert.equal(
					countOccurrences(body, escaped(effectiveText(text, inserted))),
					1,
					`"${text}" appears once with its own inserted text`,
				);
			}
		});
	});

	it("editing, switching and disabling the profile between sends keeps earlier sends stable", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(harness.sandbox.cwd, harness.sandbox.sessionDir);
			const opened = await harness.open({ sessionManager: manager, model, projectTrusted: false });
			const runtime = runtimeOf(opened);

			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: INPUT,
				inserted: { prepend: PREFIX },
				label: "first send",
			});

			await harness.writeProfile("global", "base", { prepend: EDIT_PREFIX });
			runtime.reload();
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: SECOND_INPUT,
				inserted: { prepend: EDIT_PREFIX },
				label: "after editing the profile",
			});
			const editedBody = lastBody(harness);
			assert.equal(
				countOccurrences(editedBody, escaped(effectiveText(INPUT, { prepend: PREFIX }))),
				1,
				"the first send keeps the text it was sent with",
			);

			runtime.setSelection({ mode: "off" });
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: THIRD_INPUT,
				label: "after switching off",
			});
			const offBody = lastBody(harness);
			assert.equal(
				countOccurrences(offBody, escaped(effectiveText(SECOND_INPUT, { prepend: EDIT_PREFIX }))),
				1,
				"the second send keeps the text it was sent with",
			);
			assert.equal(
				countOccurrences(offBody, escaped(THIRD_INPUT)),
				1,
				"the message sent while off is untouched",
			);
		});
	});

	it("display and the stored metadata never reach the request", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(harness.sandbox.cwd, harness.sandbox.sessionDir);
			const opened = await harness.open({ sessionManager: manager, model, projectTrusted: false });
			const runtime = runtimeOf(opened);

			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: INPUT,
				inserted: { prepend: PREFIX },
				label: "display hidden",
			});
			assert.equal(appliedEntries(manager).length, 1, "the decoration was recorded");
			assert.deepEqual(stateEntries(manager), [], "a config selection writes no state entry");

			runtime.setDisplay("global", "added");
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: SECOND_INPUT,
				inserted: { prepend: PREFIX },
				label: "display added",
			});

			// Arming and cancelling once writes two state entries and changes
			// nothing about the message the selection still applies.
			runtime.armOnce("global:base");
			runtime.cancelOnce();
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: THIRD_INPUT,
				inserted: { prepend: PREFIX },
				label: "with state entries",
			});

			const [state] = stateEntries(manager);
			assert.equal(state?.once, "global:base", "the first state entry armed once");
			assert.equal(
				stateEntries(manager).at(-1)?.once,
				undefined,
				"the last state entry disarmed it",
			);
			assert.equal(appliedEntries(manager).length, 3, "three recorded decorations");

			// Painting reads the branch and leaves the request alone.
			const [transformer] = opened.session.extensionRunner.getMarkdownTransformers();
			assert.ok(transformer);
			const stored = userMessages(manager)[2]?.text;
			assert.equal(
				transformer(stored ?? "", {
					messageType: "user",
					isStreaming: false,
					availableWidth: 80,
				}),
				THIRD_INPUT,
				"the row paints the original in the added mode",
			);
			assert.ok(
				opened.session.extensionRunner.getEntryRenderer(APPLIED_ENTRY_TYPE),
				"the entry renderer is registered",
			);
		});
	});

	it("reopening with and without the extension repeats the stored history unchanged", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(harness.sandbox.cwd, harness.sandbox.sessionDir);
			const opened = await harness.open({ sessionManager: manager, model, projectTrusted: false });

			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: INPUT,
				inserted: { prepend: PREFIX },
				label: "first send",
			});
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: SECOND_INPUT,
				inserted: { prepend: PREFIX },
				label: "second send",
			});

			const reopenedFile = await harness.copySession(manager, "reopened");
			const reopenedManager = SessionManager.open(reopenedFile);
			const reopened = await harness.open({
				sessionManager: reopenedManager,
				model,
				projectTrusted: false,
			});
			await assertTurnKeepsCache({
				harness,
				provider,
				session: reopened.session,
				text: THIRD_INPUT,
				inserted: { prepend: PREFIX },
				label: "third send after reopen with the extension",
			});

			// The same saved session, opened with no extension at all: the history
			// it sends is the stored effective text, unchanged and not re-inserted.
			const freeFile = await harness.copySession(reopenedManager, "plugin-free");
			const free = await harness.open({
				sessionManager: SessionManager.open(freeFile),
				withExtension: false,
				model,
				projectTrusted: false,
			});
			const freeBody = await sendTurn(free.session, harness.transport, FOURTH_INPUT);
			const storedApplied = appliedEntries(reopenedManager).length;
			assert.equal(storedApplied, 3, "three stored decorations travel with the history");
			for (const text of [INPUT, SECOND_INPUT, THIRD_INPUT]) {
				assert.equal(
					countOccurrences(freeBody, escaped(effectiveText(text, { prepend: PREFIX }))),
					1,
					`the plugin-free reopen sends "${text}" with its stored text`,
				);
			}
			assert.equal(
				countOccurrences(freeBody, escaped(FOURTH_INPUT)),
				1,
				"the plugin-free reopen sends the new message untouched",
			);
			assert.equal(
				countOccurrences(freeBody, escaped(PREFIX)),
				3,
				"the prefix travels exactly once per stored message and nowhere else",
			);
			assert.equal(
				appliedEntries(free.session.sessionManager).length,
				storedApplied,
				"the plugin-free reopen added no decoration of its own",
			);
		});
	});

	it("commands, display changes and reports between sends change no request", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeProfile("global", "other", { prepend: OTHER_PREFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:base" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			// The menu answers: the display entry, the global scope, then hidden.
			const ui = new ScriptedUI({ choices: ["display", "global", "hidden"] });
			const opened = await harness.open({
				sessionManager: manager,
				model,
				projectTrusted: false,
				ui,
			});

			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: INPUT,
				inserted: { prepend: PREFIX },
				label: "before any command",
			});

			await opened.session.prompt("/push config set display added");
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: SECOND_INPUT,
				inserted: { prepend: PREFIX },
				label: "after display added by command",
			});

			const beforeMenu = harness.transport.requests.length;
			await opened.session.prompt("/push");
			assert.equal(
				harness.transport.requests.length,
				beforeMenu,
				"the menu entry sent nothing",
			);
			assert.equal(runtimeOf(opened).display(), "hidden", "the menu wrote the value");
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: THIRD_INPUT,
				inserted: { prepend: PREFIX },
				label: "after display hidden by the menu",
			});

			await opened.session.prompt("/push once global:base");
			await opened.session.prompt("/push once off");
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: FOURTH_INPUT,
				inserted: { prepend: PREFIX },
				label: "after once was armed and cancelled",
			});

			await opened.session.prompt("/push use global:other");
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: FIFTH_INPUT,
				inserted: { prepend: OTHER_PREFIX },
				label: "after the selection changed by command",
			});

			const measured = harness.transport.requests.length;
			for (const command of [
				"/push status",
				"/push why",
				"/push validate",
				"/push show",
				"/push preview",
			]) {
				await opened.session.prompt(command);
			}
			assert.equal(
				harness.transport.requests.length,
				measured,
				"the reports sent nothing",
			);
			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: SIXTH_INPUT,
				inserted: { prepend: OTHER_PREFIX },
				label: "after status, why, validate, show and preview",
			});

			// Every earlier send still carries the text it was sent with.
			const body = lastBody(harness);
			for (const [text, inserted] of [
				[INPUT, { prepend: PREFIX }],
				[SECOND_INPUT, { prepend: PREFIX }],
				[THIRD_INPUT, { prepend: PREFIX }],
				[FOURTH_INPUT, { prepend: PREFIX }],
				[FIFTH_INPUT, { prepend: OTHER_PREFIX }],
			] as const) {
				assert.equal(
					countOccurrences(body, escaped(effectiveText(text, inserted))),
					1,
					`"${text}" travels with the text it was sent with`,
				);
			}
		});
	});

	it("picks up the new model's binding after a switch, adding only its text", async () => {
		await withPushHarness(async (harness) => {
			const target = NEXT_PROVIDER[provider];
			const targetModel = modelOf(target);
			await harness.writeProfile("global", "current", { prepend: PREFIX });
			await harness.writeProfile("global", "target", { prepend: SWITCH_PREFIX });
			await harness.writeConfig("global", {
				bindings: [
					{
						id: "current",
						profile: "global:current",
						match: [{ provider: model.providerId, model: model.modelId }],
					},
					{
						id: "target",
						profile: "global:target",
						match: [
							{ provider: targetModel.providerId, model: targetModel.modelId },
						],
					},
				],
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				model,
				projectTrusted: false,
			});

			await assertTurnKeepsCache({
				harness,
				provider,
				session: opened.session,
				text: INPUT,
				inserted: { prepend: PREFIX },
				label: "before the model switch",
			});

			const next = opened.session.modelRuntime.getModel(
				targetModel.providerId,
				targetModel.modelId,
			);
			assert.ok(
				next,
				`the harness offers ${targetModel.providerId}/${targetModel.modelId}`,
			);
			await opened.session.setModel(next);

			await assertTurnKeepsCache({
				harness,
				provider: target,
				session: opened.session,
				text: SECOND_INPUT,
				inserted: { prepend: SWITCH_PREFIX },
				// Pi may clamp the thinking level for the new model; the baseline has to
				// start in the state the switch produced, or it is not the same request.
				thinkingLevel: opened.session.thinkingLevel,
				label: `after switching to ${targetModel.providerId}/${targetModel.modelId}`,
			});
		});
	});
}

describe("push-prompts: provider cache prefix (Anthropic Messages)", () => {
	testProvider({
		provider: "anthropic",
		providerId: SYNTHETIC_PROVIDER_ID,
		modelId: SYNTHETIC_MODEL_ID,
	});
});

describe("push-prompts: provider cache prefix (OpenAI Responses)", () => {
	testProvider({
		provider: "openai",
		providerId: "openai",
		modelId: SYNTHETIC_OPENAI_MODEL_ID,
	});
});

describe("push-prompts: provider cache prefix (Google Generative AI)", () => {
	testProvider({
		provider: "google",
		providerId: "google",
		modelId: SYNTHETIC_GOOGLE_MODEL_ID,
	});
});
