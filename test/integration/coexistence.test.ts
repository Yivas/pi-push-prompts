/**
 * Coexistence with the sibling `pi-prompt-profiles` extension (`/sp`), which
 * edits the system prompt, on the Pi version this repository pins.
 *
 * The bound on every turn measured here: the request with both extensions may
 * differ from the request with `pi-prompt-profiles` alone — the same history,
 * either a copy of the candidate's saved session or, before anything is
 * persisted, a fresh session — only in the text Push inserted into the new user
 * message. The system prompt the profile produces, the tools, the cache markers
 * and every earlier message stay byte-identical. Nothing is normalized to make a
 * comparison pass; the one field removed is OpenAI's `prompt_cache_key`, and only
 * after asserting that each body carries its own session id.
 *
 * The sibling extension is loaded from its checkout, so what runs here is
 * whatever it really does on this Pi version: no hook is stubbed and no part of
 * it is reimplemented. `PI_PROMPT_PROFILES_CHECKOUT` names that checkout; with
 * the variable unset there is nothing to load, so the suite registers one skip
 * instead of failing. `prompt-profiles-harness.ts` has to be imported first,
 * because it clears `PI_PACKAGE_DIR` through `pinned-pi-package.ts` before
 * anything imports Pi.
 */

import {
	loadPromptProfilesExtension,
	promptProfilesSkipReason,
	removePromptProfilesSources,
	writePromptProfilesConfig,
	writePromptProfilesProfile,
	type PromptProfilesSource,
} from "../support/prompt-profiles-harness.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	type AgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	SYNTHETIC_GOOGLE_MODEL_ID,
	SYNTHETIC_MODEL_ID,
	SYNTHETIC_OPENAI_MODEL_ID,
	SYNTHETIC_PROVIDER_ID,
} from "../support/isolated-session.ts";
import {
	type OpenedSession,
	PREFIX,
	type PushHarness,
	assertSameSerialized,
	countOccurrences,
	effectiveText,
	escaped,
	itemText,
	requestView,
	sendTurn,
	withPushHarness,
} from "../support/push-harness.ts";
import type { SyntheticProvider } from "../support/synthetic-transport.ts";

const INPUT = "Synthetic coexistence input.";
const SECOND_INPUT = "Synthetic coexistence input two.";
const SP_PROFILE = "spbase";
const SP_TEXT = "SYNTHETIC-SP-BEFORE";
const PUSH_PROFILE = "pbase";

interface ProviderCase {
	readonly provider: SyntheticProvider;
	readonly providerId: string;
	readonly modelId: string;
}

const ANTHROPIC: ProviderCase = {
	provider: "anthropic",
	providerId: SYNTHETIC_PROVIDER_ID,
	modelId: SYNTHETIC_MODEL_ID,
};

const PROVIDERS: readonly ProviderCase[] = [
	ANTHROPIC,
	{
		provider: "openai",
		providerId: "openai",
		modelId: SYNTHETIC_OPENAI_MODEL_ID,
	},
	{
		provider: "google",
		providerId: "google",
		modelId: SYNTHETIC_GOOGLE_MODEL_ID,
	},
];

const SOURCES: readonly PromptProfilesSource[] = ["working-tree", "3f6d583"];

/** Why the suite cannot run here, or `false` when the checkout can answer for both sides. */
const SKIP = promptProfilesSkipReason();

type LoadOrder = "profiles-first" | "push-first";

let baselineCounter = 0;

after(removePromptProfilesSources);

function modelOf(provider: SyntheticProvider): ProviderCase {
	const found = PROVIDERS.find((entry) => entry.provider === provider);
	assert.ok(found, `the harness offers ${provider}`);
	return found;
}

function sourceLabel(source: PromptProfilesSource): string {
	return source === "working-tree" ? "checkout as it stands" : `at ${source}`;
}

/** Push inserts PREFIX; the profiles extension prepends its managed block. */
async function seedBoth(harness: PushHarness): Promise<void> {
	await harness.writeProfile("global", PUSH_PROFILE, { prepend: PREFIX });
	await harness.writeConfig("global", {
		selection: { mode: "manual", profile: `global:${PUSH_PROFILE}` },
	});
	await writePromptProfilesProfile(harness.sandbox, "global", SP_PROFILE, `${SP_TEXT}\n`);
	await writePromptProfilesConfig(harness.sandbox, "global", {
		selection: { mode: "manual", profile: `global:${SP_PROFILE}` },
	});
}

async function openBoth(
	harness: PushHarness,
	sessionManager: SessionManager,
	model: ProviderCase,
	source: PromptProfilesSource,
	order: LoadOrder,
): Promise<OpenedSession> {
	const profiles = await loadPromptProfilesExtension(source);
	return harness.open({
		sessionManager,
		model,
		projectTrusted: false,
		...(order === "profiles-first"
			? { extensionsBefore: [profiles] }
			: { extensionsAfter: [profiles] }),
	});
}

async function openProfilesOnly(
	harness: PushHarness,
	sessionManager: SessionManager,
	model: ProviderCase,
	source: PromptProfilesSource,
): Promise<OpenedSession> {
	return harness.open({
		sessionManager,
		model,
		projectTrusted: false,
		withExtension: false,
		extensionsBefore: [await loadPromptProfilesExtension(source)],
	});
}

interface ComparedTurn {
	/** The candidate's body, for the assertions about the message itself. */
	readonly candidateBody: string;
	readonly baselineBody: string;
}

interface MeasuredTurn {
	readonly harness: PushHarness;
	readonly provider: SyntheticProvider;
	readonly session: AgentSession;
	readonly text: string;
	readonly source: PromptProfilesSource;
	readonly label: string;
}

/**
 * Sends the same new message through the profiles extension alone on the same
 * history, then through both extensions, and compares the serialized bodies.
 */
async function assertTurnKeepsRequest(
	turn: MeasuredTurn,
): Promise<ComparedTurn> {
	const { harness, provider, session, text, source, label } = turn;
	const manager = session.sessionManager;
	const sessionFile = manager.getSessionFile();
	// Pi writes the session file with the first persisted message. Before that the
	// history is empty, and a fresh profiles-only session carries the same history.
	const saved = sessionFile !== undefined && existsSync(sessionFile);
	baselineCounter += 1;
	const baseline = await openProfilesOnly(
		harness,
		saved
			? SessionManager.open(
					await harness.copySession(manager, `coexistence-${baselineCounter}`),
				)
			: SessionManager.create(harness.sandbox.cwd, harness.sandbox.sessionDir),
		modelOf(provider),
		source,
	);
	const baselineBody = await sendTurn(baseline.session, harness.transport, text);
	const candidateBody = await sendTurn(session, harness.transport, text);

	let candidate = candidateBody;
	let comparable = baselineBody;
	if (provider === "openai") {
		// The adapter stamps the session id into the body. It is the same string for
		// a copy of the same file, so it proves identity rather than a choice either
		// extension could make, and it is excluded from both sides afterwards.
		const candidateKey = promptCacheKey(candidateBody);
		const baselineKey = promptCacheKey(baselineBody);
		assert.equal(
			candidateKey,
			manager.getSessionId(),
			`${label}: the candidate's prompt_cache_key is its session id`,
		);
		assert.equal(
			baselineKey,
			baseline.session.sessionManager.getSessionId(),
			`${label}: the baseline's prompt_cache_key is its session id`,
		);
		candidate = withoutPromptCacheKey(candidateBody, candidateKey);
		comparable = withoutPromptCacheKey(baselineBody, baselineKey);
	}

	const effective = effectiveText(text, { prepend: PREFIX });
	assert.equal(
		countOccurrences(candidate, escaped(effective)),
		1,
		`${label}: Push's text is inserted into the new message exactly once`,
	);
	assertSameSerialized(
		candidate.replace(escaped(effective), escaped(text)),
		comparable,
		`${label}: request with only that inserted text removed`,
	);
	return { candidateBody, baselineBody };
}

function promptCacheKey(body: string): string {
	const key = requestView("openai", body).parsed.prompt_cache_key;
	if (typeof key !== "string") {
		assert.fail("the OpenAI body carries no prompt_cache_key");
	}
	return key;
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

/**
 * The system prompt of a serialized body as text. Each adapter puts it
 * somewhere else: Anthropic in top-level `system`, OpenAI Responses as the
 * leading `developer` item, Google in `systemInstruction`.
 */
function systemText(provider: SyntheticProvider, body: string): string {
	const parsed = JSON.parse(body) as Record<string, unknown>;
	if (provider === "anthropic") {
		return textOf(parsed.system);
	}
	if (provider === "openai") {
		const items = Array.isArray(parsed.input) ? parsed.input : [];
		const system = items.find((item) => {
			const role = (item as Record<string, unknown>).role;
			return role === "system" || role === "developer";
		});
		return textOf(system);
	}
	return textOf(parsed.systemInstruction);
}

/** Text of the blocks an adapter keeps one prompt in. */
function textOf(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return joinBlockText(value);
	}
	const record = (value ?? {}) as Record<string, unknown>;
	if (typeof record.content === "string") {
		return record.content;
	}
	for (const blocks of [record.content, record.parts]) {
		if (Array.isArray(blocks)) {
			return joinBlockText(blocks);
		}
	}
	return "";
}

function joinBlockText(blocks: readonly unknown[]): string {
	return blocks
		.map((block) => {
			const text = (block as Record<string, unknown>).text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

function noticesSince(opened: OpenedSession, from: number): string[] {
	return opened.notices.slice(from).map((notice) => notice.message);
}

describe("push-prompts + pi-prompt-profiles: commands, flags and configuration", { skip: SKIP }, () => {
	it("gives each extension its own command, its own flag names and its own system prompt hook", async () => {
		await withPushHarness(async (harness) => {
			await seedBoth(harness);
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await openBoth(
				harness,
				manager,
				ANTHROPIC,
				"working-tree",
				"profiles-first",
			);
			const runner = opened.session.extensionRunner;

			const commands = runner
				.getRegisteredCommands()
				.map((command) => command.name)
				.sort();
			assert.deepEqual(commands, ["push", "sp"], "one command per extension, neither replaced");
			assert.deepEqual(
				[...runner.getFlags().keys()].sort(),
				["push-auto", "push-off", "push-profile", "sp-auto", "sp-off", "sp-profile"],
				"no flag name is shared or lost",
			);

			// The structured system-transcript hook arrived with VERSION 1.4.0, which
			// this repository pins, so the profile reaches the request through it. Push
			// registers no such hook: the run below loads Push alone to prove that.
			assert.equal(
				runner.hasHandlers("context_with_system"),
				true,
				"the profiles extension uses the hook Pi 1.4.0 has",
			);
			const pushOnly = await harness.open({
				sessionManager: SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				),
				model: ANTHROPIC,
				projectTrusted: false,
			});
			assert.equal(
				pushOnly.session.extensionRunner.hasHandlers("context_with_system"),
				false,
				"Push registers no system-transcript hook",
			);

			const before = harness.transport.requests.length;
			await opened.session.prompt("/push status");
			const pushNotice = noticesSince(opened, 0).at(-1) ?? "";
			assert.match(pushNotice, /Push Prompts/, "/push answers with its own report");
			assert.doesNotMatch(pushNotice, /mode: /, "/push did not run the other command");

			await opened.session.prompt("/sp status");
			const profilesNotice = noticesSince(opened, 1).at(-1) ?? "";
			assert.match(profilesNotice, /^mode: /, "/sp answers with its own report");
			assert.doesNotMatch(
				profilesNotice,
				/Push Prompts/,
				"/sp did not run the other command",
			);
			assert.equal(
				harness.transport.requests.length,
				before,
				"neither report sent a request",
			);
		});
	});

	it("reads each configuration from its own directory and survives the other one breaking", async () => {
		await withPushHarness(async (harness) => {
			await seedBoth(harness);
			const firstManager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const first = await openBoth(
				harness,
				firstManager,
				ANTHROPIC,
				"working-tree",
				"profiles-first",
			);
			const firstBody = await sendTurn(
				first.session,
				harness.transport,
				INPUT,
			);
			assert.ok(
				systemText("anthropic", firstBody).includes(SP_TEXT),
				"the profile reached the system prompt",
			);
			assert.equal(
				countOccurrences(firstBody, escaped(effectiveText(INPUT, { prepend: PREFIX }))),
				1,
				"Push decorated the new message",
			);

			const roots = await readdir(harness.sandbox.agentDir);
			assert.deepEqual(
				roots.filter((entry) => entry === "push-prompts" || entry === "system-prompts").sort(),
				["push-prompts", "system-prompts"],
				"each extension wrote its own directory",
			);
			assert.deepEqual(
				(await readdir(join(harness.sandbox.agentDir, "system-prompts"))).sort(),
				["config.json", "profiles"],
				"the sibling extension keeps config and profiles under its own root",
			);

			// A config the sibling extension rejects must leave Push working and the
			// system prompt back at Pi's own text.
			await writePromptProfilesConfig(harness.sandbox, "global", { version: 99 });
			const brokenManager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const broken = await openBoth(
				harness,
				brokenManager,
				ANTHROPIC,
				"working-tree",
				"profiles-first",
			);
			const measured = await assertTurnKeepsRequest({
				harness,
				provider: "anthropic",
				session: broken.session,
				text: SECOND_INPUT,
				source: "working-tree",
				label: "with a rejected profiles config",
			});
			assert.equal(
				systemText("anthropic", measured.baselineBody).includes(SP_TEXT),
				false,
				"the rejected config kept the profile out of the prompt",
			);
			assert.equal(
				itemText("anthropic", requestView("anthropic", measured.candidateBody).items.at(-1)),
				effectiveText(SECOND_INPUT, { prepend: PREFIX }),
				"Push still decorated the new message",
			);
			assert.ok(
				noticesSince(broken, 0).some(
					(notice) => notice.includes("pi-prompt-profiles") && notice.includes("version"),
				),
				"the sibling extension reported its own config problem",
			);
			assert.deepEqual(
				broken.notices.filter(
					(notice) =>
						notice.type === "error" &&
						notice.message.startsWith("push-prompts:"),
				),
				[],
				"Push reported nothing",
			);
		});
	});
});

function testSource(source: PromptProfilesSource): void {
	for (const providerCase of PROVIDERS) {
		const { provider } = providerCase;
		describe(`push-prompts + pi-prompt-profiles ${sourceLabel(source)}: coexistence (${provider})`, { skip: SKIP }, () => {
			it("adds only its text to the request profiles alone would send", async () => {
				await withPushHarness(async (harness) => {
					await seedBoth(harness);
					const manager = SessionManager.create(
						harness.sandbox.cwd,
						harness.sandbox.sessionDir,
					);
					const opened = await openBoth(
						harness,
						manager,
						providerCase,
						source,
						"profiles-first",
					);

					// First send: the history is still empty, so the baseline is a fresh
					// profiles-only session and the OpenAI session ids differ.
					const first = await assertTurnKeepsRequest({
						harness,
						provider,
						session: opened.session,
						text: INPUT,
						source,
						label: "first send",
					});
					assert.ok(
						systemText(provider, first.baselineBody).includes(SP_TEXT),
						"the profile alone reached the system prompt",
					);
					assert.equal(
						systemText(provider, first.candidateBody),
						systemText(provider, first.baselineBody),
						"Push changed nothing in the system prompt",
					);
					assert.deepEqual(
						requestView(provider, first.candidateBody).parsed.tools,
						requestView(provider, first.baselineBody).parsed.tools,
						"Push changed nothing in the tools",
					);
					assert.equal(
						itemText(provider, requestView(provider, first.candidateBody).items.at(-1)),
						effectiveText(INPUT, { prepend: PREFIX }),
						"the new user message carries exactly Push's text",
					);

					// Second send: the baseline is a copy of the same saved session, so
					// the whole history is compared, cache markers included.
					const second = await assertTurnKeepsRequest({
						harness,
						provider,
						session: opened.session,
						text: SECOND_INPUT,
						source,
						label: "second send",
					});
					assert.equal(
						itemText(provider, requestView(provider, second.candidateBody).items.at(-1)),
						effectiveText(SECOND_INPUT, { prepend: PREFIX }),
						"the second new message carries exactly Push's text",
					);
					assert.equal(
						countOccurrences(second.candidateBody, escaped(PREFIX)),
						2,
						"Push's text travels once per new message and nowhere else",
					);
				});
			});

			it("builds the same request whichever extension loads first", async () => {
				await withPushHarness(async (harness) => {
					await seedBoth(harness);
					const manager = SessionManager.create(
						harness.sandbox.cwd,
						harness.sandbox.sessionDir,
					);
					const profilesFirst = await openBoth(
						harness,
						manager,
						providerCase,
						source,
						"profiles-first",
					);
					await sendTurn(profilesFirst.session, harness.transport, INPUT);

					// The copy keeps the session id, so even OpenAI's prompt_cache_key is part
					// of the comparison without being excluded. Both sessions then send the
					// same new message over the same history.
					const copy = await harness.copySession(manager, "push-first");
					const pushFirst = await openBoth(
						harness,
						SessionManager.open(copy),
						providerCase,
						source,
						"push-first",
					);
					const pushFirstBody = await sendTurn(
						pushFirst.session,
						harness.transport,
						SECOND_INPUT,
					);
					const profilesFirstBody = await sendTurn(
						profilesFirst.session,
						harness.transport,
						SECOND_INPUT,
					);
					assertSameSerialized(
						profilesFirstBody,
						pushFirstBody,
						"load order changes nothing in the request",
					);
					// The other order is measured against the profiles-only request above, and
					// the two orders are byte-identical, so loading Push last keeps the same
					// prefix for the same reason.
					assert.ok(
						systemText(provider, pushFirstBody).includes(SP_TEXT),
						"the profile is in the request whichever extension loaded first",
					);
					assert.equal(
						itemText(
							provider,
							requestView(provider, pushFirstBody).items.at(-1),
						),
						effectiveText(SECOND_INPUT, { prepend: PREFIX }),
						"Push decorated the message whichever extension loaded first",
					);
				});
			});
		});
	}
}

for (const source of SOURCES) {
	testSource(source);
}
