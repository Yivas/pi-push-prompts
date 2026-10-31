/**
 * The `/push` surface through the real Pi runner: what each command writes, what
 * a rejected send does to the text and to `once`, and what the read-only
 * commands report.
 *
 * Commands are driven the way the host drives them, with `session.prompt("/push
 * …")`; dialogs answer through `ScriptedUI`, which builds the real picker
 * component and scripts only its answer. **Painting is not exercised**: no TUI
 * exists in a test process, so `render` and the list's key handling are
 * `not-run`. Every assertion here is about state, files and notices.
 */

import "../support/pinned-pi-package.ts";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_PROFILE_BYTES, PREPEND_FILE } from "../../src/core/profiles.ts";
import { SYNTHETIC_OPENAI_MODEL_ID } from "../support/isolated-session.ts";
import {
	appliedEntries,
	branchStateEntries,
	effectiveText,
	itemText,
	PREFIX,
	type PushHarness,
	requestView,
	SEPARATOR,
	ScriptedUI,
	sendTurn,
	stateEntries,
	SUFFIX,
	userMessages,
	withPushHarness,
} from "../support/push-harness.ts";

const INPUT = "Synthetic command input.";
const SECOND_INPUT = "Synthetic second command input.";
const THIRD_INPUT = "Synthetic third command input.";
const FOURTH_INPUT = "Synthetic fourth command input.";
const STORED_PREFIX = "SYNTHETIC-STORED-BEFORE";
const FLAG_PREFIX = "SYNTHETIC-FLAG-BEFORE";
const ONCE_PREFIX = "SYNTHETIC-ONCE-BEFORE";
const SECOND_PREFIX = "SYNTHETIC-SECOND-BEFORE";

function globalRoot(harness: PushHarness): string {
	return join(harness.sandbox.agentDir, "push-prompts");
}

async function readConfig(
	harness: PushHarness,
	scope: "global" | "project" = "global",
): Promise<Record<string, unknown>> {
	const path =
		scope === "global"
			? join(globalRoot(harness), "config.json")
			: join(harness.sandbox.cwd, ".pi", "push-prompts", "config.json");
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function noticesSince(
	opened: { readonly notices: ReadonlyArray<{ message: string }> },
	from: number,
): string[] {
	return opened.notices.slice(from).map((notice) => notice.message);
}

/** The last assistant turn, which is the only thing promised to be a reply. */
function userTextOf(body: string): string | undefined {
	return itemText("anthropic", requestView("anthropic", body).items.at(-1));
}

describe("push-prompts: /push refuses a send it cannot check", () => {
	it("stops the send and gives the text back when the selected profile is missing", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:missing" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			await opened.session.prompt(INPUT);

			assert.equal(harness.transport.requests.length, 0, "nothing was sent");
			assert.deepEqual(opened.editorTexts, [INPUT], "the text is back in the editor");
			assert.equal(appliedEntries(manager).length, 0, "nothing was decorated");
			const notice = opened.notices.at(-1)?.message ?? "";
			assert.match(notice, /was not found/i);
			assert.match(
				notice,
				/^push-prompts: \[[a-z0-9-]+\] /,
				"the notice names the diagnostic code before the message",
			);
			assert.equal(opened.notices.at(-1)?.type, "error");
			assert.doesNotMatch(
				notice,
				new RegExp(PREFIX),
				"the diagnostic never quotes a profile body",
			);
		});
	});

	it("lists the resolution error that stopped the send in /push validate", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {
				selection: { mode: "manual", profile: "global:missing" },
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			await opened.session.prompt(INPUT);
			const blocked = opened.notices.at(-1)?.message ?? "";
			const code = /\[([a-z0-9-]+)\]/.exec(blocked)?.[1];
			assert.ok(code, "the blocking notice names a diagnostic code");

			await opened.session.prompt("/push validate");
			const report = opened.notices.at(-1)?.message ?? "";
			assert.ok(
				report.includes(`[${code}]`),
				"validate lists the code the send was stopped with",
			);
		});
	});

	it("prints no problems when nothing is configured", async () => {
		await withPushHarness(async (harness) => {
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			await opened.session.prompt("/push validate");

			const report = opened.notices.at(-1)?.message ?? "";
			assert.match(report, /diagnostics: 0/);
			assert.match(report, /No problems found\./);
		});
	});

	it("stops the send when the config cannot be parsed and keeps once armed", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await mkdir(globalRoot(harness), { recursive: true });
			await writeFile(
				join(globalRoot(harness), "config.json"),
				"{ this is not json",
				"utf8",
			);
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			assert.ok(opened.runtime);
			opened.runtime.armOnce("global:base");

			await opened.session.prompt(INPUT);

			assert.equal(harness.transport.requests.length, 0, "nothing was sent");
			assert.deepEqual(opened.editorTexts, [INPUT], "the text is back in the editor");
			assert.equal(
				branchStateEntries(manager).at(-1)?.once,
				"global:base",
				"once was not consumed",
			);
			assert.match(opened.notices.at(-1)?.message ?? "", /invalid JSON/i);
		});
	});

	it("fails closed when the config file cannot be read, and off still lets a send through", async () => {
		await withPushHarness(async (harness) => {
			// A directory where the file belongs makes the read itself fail, which is
			// the path the pre-check cannot inspect: it must stop the send anyway.
			await mkdir(join(globalRoot(harness), "config.json"), { recursive: true });
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			await opened.session.prompt(INPUT);

			assert.equal(harness.transport.requests.length, 0, "the send was stopped");
			assert.deepEqual(opened.editorTexts, [INPUT], "the text is back in the editor");
			assert.match(
				opened.notices.at(-1)?.message ?? "",
				/could not run/i,
				"the user is told the check failed",
			);

			// The escape hatch has to stay reachable while the file is broken.
			await opened.session.prompt("/push off");
			const stored = branchStateEntries(manager).at(-1)?.selection as
				| { mode?: string }
				| undefined;
			assert.equal(stored?.mode, "off", "off is stored on the branch");

			const body = await sendTurn(opened.session, harness.transport, SECOND_INPUT);
			assert.equal(
				userTextOf(body),
				SECOND_INPUT,
				"an explicit off sends the message as written",
			);
			assert.deepEqual(appliedEntries(manager), [], "no decoration was recorded");
		});
	});
});

describe("push-prompts: /push changes the session state", () => {
	it("arms once and cancels it, consuming neither before a message finalizes", async () => {
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

			await opened.session.prompt("/push once global:base");
			assert.equal(
				branchStateEntries(manager).at(-1)?.once,
				"global:base",
				"the profile is armed",
			);
			await opened.session.prompt("/push once off");
			assert.equal(
				branchStateEntries(manager).at(-1)?.once,
				undefined,
				"the armed profile was cancelled",
			);
			assert.equal(
				harness.transport.requests.length,
				0,
				"commands send nothing",
			);

			await opened.session.prompt("/push once global:base");
			const body = await sendTurn(opened.session, harness.transport, INPUT);
			assert.equal(userTextOf(body), effectiveText(INPUT, { prepend: PREFIX }));
			assert.equal(
				branchStateEntries(manager).at(-1)?.once,
				undefined,
				"the finalized message consumed it",
			);
			assert.equal(appliedEntries(manager).length, 1);
			assert.deepEqual(userMessages(manager).map((entry) => entry.text), [
				effectiveText(INPUT, { prepend: PREFIX }),
			]);
		});
	});

	it("changes the selection with use, auto and off", async () => {
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

			await opened.session.prompt("/push use global:base");
			const first = await sendTurn(opened.session, harness.transport, INPUT);
			assert.equal(userTextOf(first), effectiveText(INPUT, { prepend: PREFIX }));

			// auto resolves from bindings and defaults only: the stored config
			// selection is `off`, and a session choice never falls back to it.
			await opened.session.prompt("/push auto");
			const second = await sendTurn(opened.session, harness.transport, SECOND_INPUT);
			assert.equal(userTextOf(second), SECOND_INPUT);

			await opened.session.prompt("/push use global:base");
			await opened.session.prompt("/push off");
			const third = await sendTurn(opened.session, harness.transport, THIRD_INPUT);
			assert.equal(userTextOf(third), THIRD_INPUT);
			assert.equal(appliedEntries(manager).length, 1, "only the first send was decorated");
		});
	});

	it("refuses a profile that does not exist instead of storing it", async () => {
		await withPushHarness(async (harness) => {
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			await opened.session.prompt("/push use global:missing");
			await opened.session.prompt("/push once global:missing");

			assert.match(opened.notices.at(-1)?.message ?? "", /was not found/i);
			assert.deepEqual(
				stateEntries(manager),
				[],
				"a rejected reference writes no state",
			);
		});
	});

	it("writes display with a command and through the menu entry", async () => {
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

			await opened.session.prompt("/push config set display added");
			assert.equal(
				(await readConfig(harness)).display,
				"added",
				"the setting was written to the global config",
			);
			assert.equal(opened.runtime?.display(), "added");

			// The menu walks Settings → Added text → the value, then redraws.
			const ui = new ScriptedUI({
				choices: ["settings", "display", "hidden", undefined, undefined],
			});
			const menuOpened = await harness.open({
				sessionManager: SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				),
				projectTrusted: false,
				ui,
			});
			await menuOpened.session.prompt("/push");

			assert.deepEqual(
				ui.dialogs.map((dialog) => dialog.title),
				[
					"Push · Active: global:base (session) · Next: none",
					"Push · Settings",
					"Added text in the global config",
					"Push · Settings",
					"Push · Active: global:base (session) · Next: none",
				],
				"the menu drew the screen, the value, the refreshed screen and the title again",
			);
			assert.equal(
				(await readConfig(harness)).display,
				"hidden",
				"the menu entry wrote the value it was given",
			);
			assert.equal(harness.transport.requests.length, 0, "no dialog sent anything");
		});
	});
});

describe("push-prompts: /push reports without changing the transcript", () => {
	it("prints status, why, validate and show without quoting a profile body", async () => {
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
			const before = opened.notices.length;

			await opened.session.prompt("/push status");
			await opened.session.prompt("/push why");
			await opened.session.prompt("/push validate");
			await opened.session.prompt("/push show");

			const reports = noticesSince(opened, before);
			assert.equal(reports.length, 4, "one report per command");
			assert.match(reports[0] ?? "", /profile: global:base/);
			assert.match(reports[1] ?? "", /global:base/);
			assert.match(reports[2] ?? "", /global profiles: 1/);
			assert.match(reports[3] ?? "", /original:/);
			assert.match(reports[3] ?? "", /effective \(what was sent\):/);
			// `status`, `why` and `validate` describe the configuration; only `show`
			// prints message text, because that is the question it answers.
			for (const report of reports.slice(0, 3)) {
				assert.doesNotMatch(
					report,
					new RegExp(PREFIX),
					"a report never prints the profile text",
				);
			}
			assert.ok(
				(reports[3] ?? "").includes(effectiveText(INPUT, { prepend: PREFIX })),
				"show prints the effective text, which is what was sent",
			);
			assert.ok(
				(reports[3] ?? "").includes(`original:\n${INPUT}`),
				"show prints the recovered original",
			);
			assert.equal(harness.transport.requests.length, 1, "reports send nothing");
			assert.equal(appliedEntries(manager).length, 1, "reports decorate nothing");
		});
	});

	it("reports the untrusted project instead of an empty project list", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			await opened.session.prompt("/push list --scope project");

			const notice = opened.notices.at(-1)?.message ?? "";
			assert.match(notice, /not trusted/);
			assert.doesNotMatch(notice, /No profiles found/);

			// The global scope still lists, so only the unread scope was refused.
			await opened.session.prompt("/push list --scope global");
			assert.match(opened.notices.at(-1)?.message ?? "", /global:base/);
		});
	});

	it("previews exactly the text a send inserts", async () => {
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

			const before = opened.notices.length;
			await opened.session.prompt("/push preview");
			const preview = opened.notices.slice(before).map((entry) => entry.message).join("\n");
			assert.equal(harness.transport.requests.length, 0, "the preview sends nothing");

			await sendTurn(opened.session, harness.transport, INPUT);
			const [entry] = appliedEntries(manager);
			assert.ok(entry, "the send was recorded");
			assert.equal(entry.insertedPrefix, `${PREFIX}${SEPARATOR}`);
			assert.equal(entry.insertedSuffix, `${SEPARATOR}${SUFFIX}`);
			assert.ok(
				preview.includes(entry.insertedPrefix),
				"the preview prints the text the send inserts before the message",
			);
			assert.ok(
				preview.includes(entry.insertedSuffix),
				"and the text it inserts after it",
			);
		});
	});
});

describe("push-prompts: /push writes configuration and profiles", () => {
	it("binds, unbinds and sets the default profile", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			await opened.session.prompt(
				"/push bind global:base --provider anthropic --model claude-sonnet-4-5 --id base-claude",
			);
			const bound = await readConfig(harness);
			assert.deepEqual(bound.bindings, [
				{
					id: "base-claude",
					profile: "global:base",
					priority: 0,
					match: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
				},
			]);

			await opened.session.prompt("/push unbind base-claude");
			assert.deepEqual((await readConfig(harness)).bindings, []);
			assert.match(opened.notices.at(-1)?.message ?? "", /Removed 1 binding/);

			await opened.session.prompt("/push default global:base");
			assert.equal((await readConfig(harness)).defaultProfile, "global:base");
		});
	});

	it("reports that /push new wrote nothing when no text was passed", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			await opened.session.prompt("/push new empty");

			const notice = opened.notices.at(-1)?.message ?? "";
			assert.match(notice, /Nothing was written/);
			assert.match(
				notice,
				/--prepend <text> or --append <text>/,
				"the notice says how to write the profile",
			);
			assert.ok(
				notice.includes(join(globalRoot(harness), "profiles", "empty")),
				"the notice names the directory the profile would use",
			);
			await assert.rejects(
				readdir(join(globalRoot(harness), "profiles", "empty")),
				"no directory was created",
			);
			assert.deepEqual(stateEntries(manager), [], "the command stored nothing");
		});
	});

	it("refuses to write through a profiles directory that leads outside the root", async (t) => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const outside = join(harness.sandbox.cwd, "outside-profiles");
			await mkdir(outside, { recursive: true });
			try {
				await symlink(outside, join(globalRoot(harness), "profiles"), "junction");
			} catch {
				t.skip("this user cannot create a directory link");
				return;
			}
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});

			await opened.session.prompt("/push new escape --prepend SYNTHETIC-ESCAPED");

			const notice = opened.notices.at(-1);
			assert.match(notice?.message ?? "", /Refusing to write outside/);
			assert.equal(notice?.type, "error");
			await assert.rejects(
				readFile(join(outside, "escape", PREPEND_FILE)),
				"no profile text was written outside the root",
			);
			assert.deepEqual(
				await readdir(outside),
				[],
				"the profile directory was never created outside the root",
			);
		});
	});

	it("refuses profile text over the limit the loader applies", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			const oversized = "X".repeat(DEFAULT_MAX_PROFILE_BYTES + 1);

			await opened.session.prompt(`/push new oversized --prepend ${oversized}`);

			const notice = opened.notices.at(-1);
			assert.equal(notice?.type, "error");
			assert.match(notice?.message ?? "", new RegExp(`${DEFAULT_MAX_PROFILE_BYTES} bytes`));
			assert.match(notice?.message ?? "", /global:oversized/, "the notice names the profile");
			await assert.rejects(
				readFile(join(globalRoot(harness), "profiles", "oversized", PREPEND_FILE)),
				"no oversized profile text was written",
			);
		});
	});

	it("refuses an oversized second part without writing the first", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			const oversized = "X".repeat(DEFAULT_MAX_PROFILE_BYTES + 1);

			await opened.session.prompt(
				`/push new partial --prepend SYNTHETIC-SMALL --append ${oversized}`,
			);

			const notice = opened.notices.at(-1);
			assert.equal(notice?.type, "error");
			assert.match(notice?.message ?? "", /Nothing was written/);
			await assert.rejects(
				readFile(join(globalRoot(harness), "profiles", "partial", PREPEND_FILE)),
				"the part that fit the limit was not written either",
			);
		});
	});

	it("creates and edits a profile through the dialogs, writing atomically", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI({
				choices: ["profiles", "create", "global", undefined, undefined],
				inputs: ["fresh"],
				editors: ["BEFORE THE MESSAGE", "AFTER THE MESSAGE", "EDITED AFTER"],
			});
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});

			// The menu's "Create a profile" entry: id, scope, prepend, append.
			await opened.session.prompt("/push");
			const directory = join(globalRoot(harness), "profiles", "fresh");
			assert.deepEqual(
				(await readdir(directory)).sort(),
				["append.md", "prepend.md"],
				"both parts were written and no temporary file was left behind",
			);
			assert.equal(
				await readFile(join(directory, "prepend.md"), "utf8"),
				"BEFORE THE MESSAGE\n",
			);
			assert.equal(
				await readFile(join(directory, "append.md"), "utf8"),
				"AFTER THE MESSAGE\n",
			);

			// The write reloads, so the new profile is usable without a second command.
			await opened.session.prompt("/push use global:fresh");
			const body = await sendTurn(opened.session, harness.transport, INPUT);
			assert.equal(
				userTextOf(body),
				effectiveText(INPUT, {
					prepend: "BEFORE THE MESSAGE",
					append: "AFTER THE MESSAGE",
				}),
				"a send uses both parts of the new profile",
			);

			await opened.session.prompt("/push edit global:fresh --part append");
			assert.equal(
				await readFile(join(directory, "append.md"), "utf8"),
				"EDITED AFTER\n",
				"the edited part was replaced",
			);
			assert.equal(
				await readFile(join(directory, "prepend.md"), "utf8"),
				"BEFORE THE MESSAGE\n",
				"the other part is untouched",
			);
		});
	});
});

describe("push-prompts: /push turns a name into an id", () => {
	it("offers the derived id, keeps the typed name as the description", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI({
				choices: ["profiles", "create", "global", undefined, undefined],
				inputs: ["Pensamiento abstracto"],
				confirms: [true],
				editors: ["BEFORE THE MESSAGE", "AFTER THE MESSAGE"],
			});
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});

			await opened.session.prompt("/push");

			const directory = join(
				globalRoot(harness),
				"profiles",
				"pensamiento-abstracto",
			);
			assert.deepEqual(
				(await readdir(directory)).sort(),
				["append.md", "prepend.md"],
				"the files are written under the derived id",
			);
			assert.equal(
				await readFile(join(directory, "prepend.md"), "utf8"),
				"BEFORE THE MESSAGE\n",
			);
			const config = await readConfig(harness);
			const profiles = config.profiles as Record<
				string,
				{ description?: string }
			>;
			assert.equal(
				profiles["pensamiento-abstracto"]?.description,
				"Pensamiento abstracto",
				"the typed name is kept as the description",
			);

			// The derived id is usable without a second command.
			await opened.session.prompt("/push use global:pensamiento-abstracto");
			const body = await sendTurn(opened.session, harness.transport, INPUT);
			assert.equal(
				userTextOf(body),
				effectiveText(INPUT, {
					prepend: "BEFORE THE MESSAGE",
					append: "AFTER THE MESSAGE",
				}),
			);
		});
	});

	it("writes nothing when the suggested id is declined", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI({
				choices: ["profiles", "create", undefined, undefined],
				inputs: ["Pensamiento abstracto"],
				confirms: [false],
			});
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});

			await opened.session.prompt("/push");

			assert.equal(opened.notices.at(-1)?.message, "Cancelled. Nothing was written.");
			await assert.rejects(
				readdir(join(globalRoot(harness), "profiles")),
				"no profile directory was created",
			);
			assert.deepEqual((await readConfig(harness)).profiles, undefined);
		});
	});

	it("reports the rule once when the name cannot become an id", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI({
				choices: ["profiles", "create", undefined],
				inputs: ["!!!"],
			});
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});
			const before = opened.notices.length;

			await opened.session.prompt("/push");

			const notices = opened.notices.slice(before);
			assert.equal(notices.length, 1, "one notification for one failure");
			assert.equal(notices[0]?.type, "error");
			assert.match(notices[0]?.message ?? "", /cannot become a profile id/);
			assert.match(notices[0]?.message ?? "", /letters, digits, dot, dash and underscore/);
			await assert.rejects(readdir(join(globalRoot(harness), "profiles")));
		});
	});

	it("writes nothing, not even the description, when a part is oversized", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI({
				choices: ["profiles", "create", "global", undefined, undefined],
				inputs: ["Pensamiento abstracto"],
				confirms: [true],
				editors: ["X".repeat(DEFAULT_MAX_PROFILE_BYTES + 1), ""],
			});
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});
			const before = opened.notices.length;

			await opened.session.prompt("/push");

			const notices = opened.notices.slice(before);
			assert.equal(notices.length, 1, "one notification for one failure");
			assert.equal(notices[0]?.type, "error");
			assert.match(notices[0]?.message ?? "", /Nothing was written/);
			await assert.rejects(
				readdir(join(globalRoot(harness), "profiles")),
				"no profile directory was created",
			);
			assert.equal(
				(await readConfig(harness)).profiles,
				undefined,
				"no description was stored for a profile that was not written",
			);
		});
	});

	it("refuses a derived id that differs only in case from an existing profile", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			await harness.writeProfile("global", "Pensamiento-abstracto", {
				prepend: PREFIX,
			});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI({
				choices: ["profiles", "create", "global", undefined, undefined],
				inputs: ["Pensamiento abstracto"],
				confirms: [true],
				editors: ["BEFORE THE MESSAGE", "AFTER THE MESSAGE"],
			});
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});
			const before = opened.notices.length;

			await opened.session.prompt("/push");

			const notices = opened.notices.slice(before);
			assert.equal(notices.length, 1, "one notification for one failure");
			assert.equal(notices[0]?.type, "error");
			assert.match(notices[0]?.message ?? "", /differs only in case/);
			assert.match(notices[0]?.message ?? "", /Pensamiento-abstracto/);
			assert.deepEqual(
				await readdir(join(globalRoot(harness), "profiles")),
				["Pensamiento-abstracto"],
				"the existing profile is the only directory",
			);
		});
	});

	it("refuses an unsafe id on the command line and names the derived one", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			const before = opened.notices.length;

			await opened.session.prompt('/push new "Pensamiento abstracto"');

			const notices = opened.notices.slice(before);
			assert.equal(notices.length, 1, "one notification for one failure");
			assert.equal(notices[0]?.type, "error");
			assert.match(notices[0]?.message ?? "", /not a valid profile id/);
			assert.match(
				notices[0]?.message ?? "",
				/Try \/push new pensamiento-abstracto\./,
			);
			await assert.rejects(readdir(join(globalRoot(harness), "profiles")));
		});
	});

	it("refuses an id that differs only in case from an existing profile", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			await harness.writeProfile("global", "Review", { prepend: PREFIX });
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			const before = opened.notices.length;

			await opened.session.prompt("/push new review --prepend SYNTHETIC-OTHER");

			const notices = opened.notices.slice(before);
			assert.equal(notices.length, 1, "one notification for one failure");
			assert.equal(notices[0]?.type, "error");
			assert.match(notices[0]?.message ?? "", /differs only in case/);
			assert.match(notices[0]?.message ?? "", /Review/);
			assert.deepEqual(
				await readdir(join(globalRoot(harness), "profiles")),
				["Review"],
				"nothing was written next to the existing profile",
			);
		});
	});

	it("stops the create when the profiles directory cannot be read", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			// A regular file where `profiles/` belongs makes the listing fail with
			// ENOTDIR, which is neither "no profiles yet" nor a collision.
			const blocker = join(globalRoot(harness), "profiles");
			await writeFile(blocker, "not a directory", "utf8");
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			const before = opened.notices.length;

			await opened.session.prompt("/push new review --prepend SYNTHETIC-OTHER");

			const notices = opened.notices.slice(before);
			assert.equal(notices.length, 1, "one notification for one failure");
			assert.equal(notices[0]?.type, "error");
			assert.match(notices[0]?.message ?? "", /could not be read/);
			assert.match(notices[0]?.message ?? "", /Nothing was written/);
			assert.equal(
				await readFile(blocker, "utf8"),
				"not a directory",
				"the blocker was left alone",
			);
		});
	});
});

/** The project scope of one sandbox, where `.pi/push-prompts` lives. */
function projectRoot(harness: PushHarness): string {
	return join(harness.sandbox.cwd, ".pi", "push-prompts");
}

describe("push-prompts: the /push menu", () => {
	it("walks the sections and backs out one level at a time", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {});
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				),
				projectTrusted: false,
				ui,
			});

			ui.answer(
				"profiles",
				"back",
				"bindings",
				"back",
				"settings",
				"back",
				"inspect",
				"back",
				"help",
				undefined,
			);
			await opened.session.prompt("/push");

			const titles = ui.dialogs.map((dialog) => dialog.title);
			assert.deepEqual(titles, [
				"Push · Active: none · Next: none",
				"Push · Profiles",
				"Push · Active: none · Next: none",
				"Push · Model bindings",
				"Push · Active: none · Next: none",
				"Push · Settings",
				"Push · Active: none · Next: none",
				"Push · Check and inspect",
				"Push · Active: none · Next: none",
				"Push · Active: none · Next: none",
			], "each Back returns one level and Help returns to the title");
			assert.deepEqual(ui.dialogs[0]?.labels, [
				"Use a profile for this session…",
				"Next message: none…",
				"Profiles…",
				"Model bindings…",
				"Settings…",
				"Check and inspect…",
				"Help",
			]);
			assert.deepEqual(ui.dialogs[1]?.labels, [
				"Browse profiles…",
				"Create a profile…",
				"Edit a profile…",
				"Back",
			]);
			assert.deepEqual(ui.dialogs[3]?.labels, [
				"Bind anthropic/claude-sonnet-4-5 to a profile…",
				"Remove a binding…",
				"Show all bindings",
				"Back",
			], "the bindings section offers no project row while the project is untrusted");
			assert.deepEqual(ui.dialogs[5]?.labels, [
				"Save changes to: Global…",
				"Selection: auto",
				"Default profile: none",
				"Subagents: bindings",
				"Added text: hidden",
				"Back",
			]);
			assert.deepEqual(ui.dialogs[7]?.labels, [
				"Status",
				"Why this profile?",
				"Preview next message",
				"Last added text",
				"Show configuration",
				"Check configuration",
				"Reload from disk",
				"Back",
			]);
			assert.match(
				opened.notices.at(-1)?.message ?? "",
				/\/push use <profile>/,
				"Help prints the command list",
			);
			assert.deepEqual(await readConfig(harness), { version: 1 }, "walking the menu wrote nothing");
			assert.equal(harness.transport.requests.length, 0, "the menu sent nothing");
		});
	});

	it("puts the active profile, its origin and the next message in the title", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "ready", { prepend: PREFIX });
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI({ choices: [undefined, undefined] });
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});

			await harness.writeConfig("global", { defaultProfile: "global:ready" });
			opened.runtime?.reload();
			await opened.session.prompt("/push");
			assert.equal(
				ui.dialogs[0]?.title,
				"Push · Active: global:ready (default) · Next: none",
				"a profile that comes from defaultProfile is named as such",
			);

			await opened.session.prompt("/push use global:ready");
			await opened.session.prompt("/push");
			assert.equal(
				ui.dialogs.at(-1)?.title,
				"Push · Active: global:ready (session) · Next: none",
				"a pinned profile is named as the session's choice",
			);

			await opened.session.prompt("/push once global:ready");
			ui.answer(undefined);
			await opened.session.prompt("/push");
			assert.equal(
				ui.dialogs.at(-1)?.title,
				"Push · Active: global:ready (session) · Next: global:ready",
				"the armed profile is named next to the active one",
			);

			await opened.session.prompt("/push once off");
			await opened.session.prompt("/push off");
			ui.answer(undefined);
			await opened.session.prompt("/push");
			assert.equal(
				ui.dialogs.at(-1)?.title,
				"Push · Active: off · Next: none",
				"an off session says so instead of naming a profile",
			);

			await harness.writeProfile("global", "a-very-long-profile-name", {
				prepend: PREFIX,
			});
			await opened.session.prompt("/push reload");
			await opened.session.prompt("/push use global:a-very-long-profile-name");
			ui.answer(undefined);
			await opened.session.prompt("/push");
			assert.equal(
				ui.dialogs.at(-1)?.title,
				"Push · Active: global:a-very-l… (session) · Next: none",
				"a long reference is shortened, never the state around it",
			);
		});
	});

	it("writes each setting in the config the menu is set to and shows the new value", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {});
			await harness.writeConfig("project", {});
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				),
				projectTrusted: true,
				ui,
			});

			ui.answer("settings", "subagents", "inherit", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(
				await readConfig(harness, "project"),
				{ version: 1, subagents: "inherit" },
				"a trusted project is where the menu writes by default",
			);
			assert.deepEqual(await readConfig(harness), { version: 1 }, "the global config is untouched");
			assert.deepEqual(
				await readdir(projectRoot(harness)),
				["config.json"],
				"the write left no temporary file behind",
			);

			ui.answer("settings", "display", "added", undefined);
			await opened.session.prompt("/push");
			assert.equal((await readConfig(harness, "project")).display, "added");
			assert.equal(opened.runtime?.display(), "added");

			ui.answer("settings", "selection", "off", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual((await readConfig(harness, "project")).selection, {
				mode: "off",
			});

			ui.answer("settings", "selection", "auto", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual((await readConfig(harness, "project")).selection, {
				mode: "auto",
			});

			ui.answer("settings", "default-profile", "global:base", undefined);
			await opened.session.prompt("/push");
			assert.equal(
				(await readConfig(harness, "project")).defaultProfile,
				"global:base",
				"the default profile is stored in the chosen config",
			);

			const start = ui.dialogs.length;
			ui.answer("settings", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(ui.dialogs[start + 1]?.labels, [
				"Save changes to: Project…",
				"Selection: auto",
				"Default profile: global:base",
				"Subagents: inherit",
				"Added text: added",
				"Back",
			], "the screen shows the values that were just written");
		});
	});

	it("offers no project config while the project is untrusted", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", {});
			await harness.writeConfig("project", {});
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				),
				projectTrusted: false,
				ui,
			});

			const start = ui.dialogs.length;
			ui.answer("settings", "save-to", undefined, undefined);
			await opened.session.prompt("/push");

			const dialogs = ui.dialogs.slice(start);
			assert.equal(dialogs[2]?.title, "Which configuration?");
			assert.deepEqual(
				dialogs[2]?.labels,
				["Global (all projects) (current)"],
				"only the config the extension may read is offered",
			);
			assert.match(
				dialogs[1]?.labels[0] ?? "",
				/^Save changes to: Global…$/,
				"the remembered scope stays global",
			);
			assert.deepEqual(
				await readConfig(harness, "project"),
				{ version: 1 },
				"the unread project config was never written",
			);
		});
	});

	it("removes a project override when the global value is chosen", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeConfig("global", { subagents: "off" });
			await harness.writeConfig("project", { subagents: "inherit" });
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				),
				projectTrusted: true,
				ui,
			});

			let start = ui.dialogs.length;
			ui.answer("settings", "subagents", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(ui.dialogs[start + 2]?.labels, [
				"off",
				"bindings",
				"inherit (current)",
				"Use global value (off)",
			], "removing the override is a row of its own, not a value");

			start = ui.dialogs.length;
			ui.answer("settings", "subagents", "use-global-value", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(
				await readConfig(harness, "project"),
				{ version: 1 },
				"the project key was removed, not set to another value",
			);
			assert.equal(
				opened.notices.at(-2)?.message,
				"subagents removed from the project config.",
			);

			start = ui.dialogs.length;
			ui.answer("settings", undefined);
			await opened.session.prompt("/push");
			assert.equal(
				ui.dialogs[start + 1]?.labels[3],
				"Subagents: off (from global)",
				"the row names the value that now applies and where it comes from",
			);

			start = ui.dialogs.length;
			ui.answer("settings", "subagents", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(
				ui.dialogs[start + 2]?.labels,
				["off (current)", "bindings", "inherit"],
				"with nothing left to remove, the selector offers values only",
			);
		});
	});

	it("keeps profiles named Off or Back apart from the rows of the menu", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "Off", { prepend: PREFIX });
			await harness.writeProfile("global", "Back", { prepend: SECOND_PREFIX });
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});

			let start = ui.dialogs.length;
			ui.answer("use-session", undefined);
			await opened.session.prompt("/push");
			const labels = ui.dialogs[start + 1]?.labels ?? [];
			assert.deepEqual(
				labels.slice(0, -2).sort(),
				["Back (global)", "Off (global)"],
				"both profiles are offered by name",
			);
			assert.deepEqual(labels.slice(-2), [
				"Automatic (follow model bindings) (current)",
				"Off for this session",
			], "the rows of the menu keep their own wording after the profiles");

			ui.answer("use-session", "global:Off");
			await opened.session.prompt("/push");
			assert.deepEqual(
				opened.runtime?.getStatus().selection,
				{ mode: "manual", profile: "global:Off" },
				"choosing the profile named Off did not turn the session off",
			);

			start = ui.dialogs.length;
			ui.answer("use-session", undefined);
			await opened.session.prompt("/push");
			const offered = ui.dialogs[start + 1]?.labels ?? [];
			assert.ok(
				offered.includes("Off (global) (current)"),
				`the chosen profile is marked and the rows are untouched: ${offered.join(" | ")}`,
			);

			ui.answer("next-message", "global:Back");
			await opened.session.prompt("/push");
			assert.equal(opened.runtime?.getStatus().once, "global:Back");

			start = ui.dialogs.length;
			ui.answer("next-message", "cancel-next");
			await opened.session.prompt("/push");
			assert.equal(
				opened.runtime?.getStatus().once,
				undefined,
				"the cancel row still cancels instead of arming a profile",
			);
			assert.equal(
				opened.notices.at(-1)?.message,
				"The profile armed for the next message was cancelled.",
			);
		});
	});

	it("never runs the first row when a picker is dismissed", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});

			let start = ui.dialogs.length;
			const notices = opened.notices.length;
			ui.answer(undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(
				ui.dialogs.slice(start).map((dialog) => dialog.kind),
				["picker"],
				"Esc at the title closed the menu without opening anything",
			);
			assert.equal(opened.notices.length, notices, "dismissing the menu says nothing");
			assert.deepEqual(stateEntries(manager), [], "nothing was stored");

			start = ui.dialogs.length;
			ui.answer("settings", undefined, undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(
				ui.dialogs.slice(start).map((dialog) => dialog.title),
				[
					"Push · Active: none · Next: none",
					"Push · Settings",
					"Push · Active: none · Next: none",
				],
				"Esc inside a screen returns to the title, and Esc there closes",
			);
			assert.deepEqual(await readConfig(harness), { version: 1 }, "nothing was written");
		});
	});

	it("offers the cancel row only while a profile is armed for the next message", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeProfile("global", "other", { prepend: SECOND_PREFIX });
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});

			let start = ui.dialogs.length;
			ui.answer("next-message", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(ui.dialogs[start + 1]?.labels, [
				"base (global)",
				"other (global)",
			], "nothing armed, nothing to cancel");

			await opened.session.prompt("/push once global:base");
			start = ui.dialogs.length;
			ui.answer("next-message", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(ui.dialogs[start + 1]?.labels, [
				"Cancel: add nothing to the next message",
				"base (global) (current)",
				"other (global)",
			], "an armed profile can be cancelled from the picker");
		});
	});

	it("closes the menu with a notice when the session profile changes", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
				ui,
			});

			const start = ui.dialogs.length;
			ui.answer("use-session", "global:base", "settings");
			await opened.session.prompt("/push");

			assert.equal(
				ui.dialogs.length - start,
				2,
				"the menu closed after the profile changed instead of redrawing",
			);
			assert.equal(opened.notices.at(-1)?.message, "Selection: global:base.");
			assert.deepEqual(branchStateEntries(manager).at(-1)?.selection, {
				mode: "manual",
				profile: "global:base",
			});
		});
	});

	it("binds the current model in the config the menu is set to", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", { prepend: PREFIX });
			await harness.writeConfig("global", {});
			await harness.writeConfig("project", {});
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				),
				projectTrusted: true,
				ui,
			});

			let start = ui.dialogs.length;
			ui.answer("bindings", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual(ui.dialogs[start + 1]?.labels, [
				"Bind anthropic/claude-sonnet-4-5 to a profile…",
				"Remove a binding…",
				"Show all bindings",
				"Inherit global bindings: yes",
				"Back",
			]);

			ui.answer("bindings", "bind", "global:base", undefined);
			await opened.session.prompt("/push");
			assert.deepEqual((await readConfig(harness, "project")).bindings, [
				{
					id: "base-anthropic-claude-sonnet-4-5",
					profile: "global:base",
					priority: 0,
					match: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
				},
			], "the binding names the model of this session and the remembered scope");
			assert.deepEqual(await readConfig(harness), { version: 1 });

			ui.answer("bindings", "inherit", "false", undefined);
			await opened.session.prompt("/push");
			assert.equal(
				(await readConfig(harness, "project")).inheritGlobalBindings,
				false,
			);

			start = ui.dialogs.length;
			ui.answer("bindings", undefined);
			await opened.session.prompt("/push");
			assert.equal(ui.dialogs[start + 1]?.labels[3], "Inherit global bindings: no");

			start = ui.dialogs.length;
			ui.answer("bindings", "list", undefined);
			await opened.session.prompt("/push");
			assert.match(
				opened.notices.at(-1)?.message ?? "",
				/^project:base-anthropic-claude-sonnet-4-5 — global:base/,
			);
		});
	});

	it("browses one profile: shows its text, stores it as the default and uses it", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "base", {
				prepend: PREFIX,
				append: SUFFIX,
			});
			await harness.writeConfig("global", {});
			await harness.writeConfig("project", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const ui = new ScriptedUI();
			const opened = await harness.open({
				sessionManager: manager,
				projectTrusted: true,
				ui,
			});

			let start = ui.dialogs.length;
			ui.answer("profiles", "browse", "global:base", undefined);
			await opened.session.prompt("/push");
			assert.equal(ui.dialogs[start + 3]?.title, "Push · global:base");
			assert.deepEqual(ui.dialogs[start + 3]?.labels, [
				"Show text",
				"Edit",
				"Use for this session",
				"Set as default",
				"Back",
			]);

			start = ui.dialogs.length;
			ui.answer("profiles", "browse", "global:base", "show-text", undefined);
			await opened.session.prompt("/push");
			const shown = opened.notices.at(-1)?.message ?? "";
			assert.match(shown, /^Text of global:base:$/m);
			assert.match(shown, new RegExp(`prepend\\.md \\(${PREFIX.length} bytes\\):`));
			assert.ok(shown.includes(PREFIX), "the profile text is printed where the person asked for it");
			assert.ok(shown.includes(SUFFIX));

			start = ui.dialogs.length;
			ui.answer("profiles", "browse", "global:base", "set-default", undefined);
			await opened.session.prompt("/push");
			assert.equal(
				(await readConfig(harness, "project")).defaultProfile,
				"global:base",
				"the default profile follows the scope the menu is set to",
			);
			assert.equal(
				opened.notices.at(-1)?.message,
				"defaultProfile set to global:base in the project config.",
			);

			start = ui.dialogs.length;
			ui.answer("profiles", "browse", "global:base", "use-session");
			await opened.session.prompt("/push");
			assert.equal(ui.dialogs.length - start, 4, "using a profile closes the menu");
			assert.equal(
				opened.runtime?.getStatus().selection.profile,
				"global:base",
			);
		});
	});
});

describe("push-prompts: /push flags", () => {
	it("rejects a combination and applies nothing", async () => {
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
				flags: { "push-auto": true, "push-off": true },
			});

			assert.match(
				opened.notices.at(-1)?.message ?? "",
				/cannot be combined/,
				"the contradiction is reported",
			);
			const body = await sendTurn(opened.session, harness.transport, INPUT);
			assert.equal(
				userTextOf(body),
				effectiveText(INPUT, { prepend: PREFIX }),
				"the config selection still applies",
			);
			assert.deepEqual(stateEntries(manager), [], "a flag writes no state entry");
		});
	});

	it("applies a single flag for the run without storing it", async () => {
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
				flags: { "push-off": true },
			});

			const body = await sendTurn(opened.session, harness.transport, INPUT);
			assert.equal(userTextOf(body), INPUT, "the flag turned decoration off");
			assert.deepEqual(stateEntries(manager), [], "nothing was stored");

			const named = await harness.open({
				sessionManager: SessionManager.create(
					harness.sandbox.cwd,
					harness.sandbox.sessionDir,
				),
				projectTrusted: false,
				flags: { "push-profile": "global:base" },
			});
			const namedBody = await sendTurn(named.session, harness.transport, SECOND_INPUT);
			assert.equal(
				userTextOf(namedBody),
				effectiveText(SECOND_INPUT, { prepend: PREFIX }),
				"the named profile applied",
			);
		});
	});

	it("keeps the stored session selection when a flag and once are used over it", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "stored", { prepend: STORED_PREFIX });
			await harness.writeProfile("global", "flagged", { prepend: FLAG_PREFIX });
			await harness.writeProfile("global", "armed", { prepend: ONCE_PREFIX });
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const chosen = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			await chosen.session.prompt("/push use global:stored");
			const storedBody = await sendTurn(chosen.session, harness.transport, INPUT);
			assert.equal(
				userTextOf(storedBody),
				effectiveText(INPUT, { prepend: STORED_PREFIX }),
				"the stored selection applies to this session",
			);
			const storedFile = await harness.copySession(manager, "stored");

			const flagged = await harness.open({
				sessionManager: SessionManager.open(storedFile),
				projectTrusted: false,
				flags: { "push-profile": "global:flagged" },
			});
			const flagBody = await sendTurn(flagged.session, harness.transport, SECOND_INPUT);
			assert.equal(
				userTextOf(flagBody),
				effectiveText(SECOND_INPUT, { prepend: FLAG_PREFIX }),
				"the flag overrides the stored selection for this run",
			);

			await flagged.session.prompt("/push once global:armed");
			const armedBody = await sendTurn(flagged.session, harness.transport, THIRD_INPUT);
			assert.equal(
				userTextOf(armedBody),
				effectiveText(THIRD_INPUT, { prepend: ONCE_PREFIX }),
				"once wins over the flag and over the stored selection",
			);

			// The next run has no flag, so the branch decides again.
			const withoutFlagFile = await harness.copySession(
				flagged.session.sessionManager,
				"without-flag",
			);
			const reopened = await harness.open({
				sessionManager: SessionManager.open(withoutFlagFile),
				projectTrusted: false,
			});
			const reopenedBody = await sendTurn(reopened.session, harness.transport, FOURTH_INPUT);
			assert.equal(
				userTextOf(reopenedBody),
				effectiveText(FOURTH_INPUT, { prepend: STORED_PREFIX }),
				"arming and consuming once under a flag kept the stored selection",
			);
		});
	});

	it("keeps a run flag across a model switch and a reload until a command replaces it", async () => {
		await withPushHarness(async (harness) => {
			await harness.writeProfile("global", "stored", { prepend: STORED_PREFIX });
			await harness.writeProfile("global", "flagged", { prepend: FLAG_PREFIX });
			await harness.writeProfile("global", "second", { prepend: SECOND_PREFIX });
			await harness.writeConfig("global", {});
			const manager = SessionManager.create(
				harness.sandbox.cwd,
				harness.sandbox.sessionDir,
			);
			const chosen = await harness.open({
				sessionManager: manager,
				projectTrusted: false,
			});
			await chosen.session.prompt("/push use global:stored");
			await sendTurn(chosen.session, harness.transport, INPUT);
			const storedFile = await harness.copySession(manager, "flagged-run");

			const flagged = await harness.open({
				sessionManager: SessionManager.open(storedFile),
				projectTrusted: false,
				flags: { "push-profile": "global:flagged" },
			});
			const next = flagged.session.modelRuntime.getModel(
				"openai",
				SYNTHETIC_OPENAI_MODEL_ID,
			);
			assert.ok(next, `the harness offers openai/${SYNTHETIC_OPENAI_MODEL_ID}`);
			await flagged.session.setModel(next);
			await flagged.session.prompt("/push reload");

			const keptBody = await sendTurn(flagged.session, harness.transport, SECOND_INPUT);
			assert.equal(
				itemText("openai", requestView("openai", keptBody).items.at(-1)),
				effectiveText(SECOND_INPUT, { prepend: FLAG_PREFIX }),
				"the flag still applies after the model switch and the reload",
			);
			// Two state writes inside the flagged run, so the newest entry comes from
			// here: it must hold the session selection and never the flag.
			await flagged.session.prompt("/push once global:stored");
			await flagged.session.prompt("/push once off");
			const written = branchStateEntries(flagged.session.sessionManager).at(-1) as
				| { selection?: { profile?: string }; once?: string }
				| undefined;
			assert.equal(
				written?.selection?.profile,
				"global:stored",
				"the flagged run writes the session selection it inherited",
			);
			assert.equal(
				written?.once,
				undefined,
				"the cancelled once is what the last entry holds",
			);
			for (const entry of stateEntries(flagged.session.sessionManager)) {
				assert.doesNotMatch(
					JSON.stringify(entry),
					/flagged/,
					"the flag is never written to the branch",
				);
			}

			await flagged.session.prompt("/push use global:second");
			const replacedBody = await sendTurn(flagged.session, harness.transport, THIRD_INPUT);
			assert.equal(
				itemText("openai", requestView("openai", replacedBody).items.at(-1)),
				effectiveText(THIRD_INPUT, { prepend: SECOND_PREFIX }),
				"an explicit command replaces the flag",
			);
			const stored = branchStateEntries(flagged.session.sessionManager).at(-1)
				?.selection as { profile?: string } | undefined;
			assert.equal(
				stored?.profile,
				"global:second",
				"the command's choice is what the branch stores",
			);
		});
	});

	it("reports a flag profile that does not exist and leaves the config selection alone", async () => {
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
				flags: { "push-profile": "global:missing" },
			});

			assert.match(opened.notices.at(-1)?.message ?? "", /was not found/i);
			const body = await sendTurn(opened.session, harness.transport, INPUT);
			assert.equal(
				userTextOf(body),
				effectiveText(INPUT, { prepend: PREFIX }),
				"the config selection still applies",
			);
		});
	});
});
