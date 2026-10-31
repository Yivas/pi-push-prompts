import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	loadState,
	readRawConfig,
	writeRawConfigIfUnchanged,
} from "../../src/core/store.ts";

const directories: string[] = [];

function makeDirectory(prefix: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function tempConfig(contents?: string): string {
	const file = path.join(makeDirectory("push-store-"), "config.json");
	if (contents !== undefined) {
		fs.writeFileSync(file, contents);
	}
	return file;
}

function readJson(filePath: string): unknown {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
	for (const directory of directories) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	directories.length = 0;
});

describe("loadState", () => {
	it("contributes nothing from an untrusted project", () => {
		const agentDir = makeDirectory("push-agent-");
		const cwd = makeDirectory("push-project-");
		writeFile(
			path.join(agentDir, "push-prompts", "config.json"),
			JSON.stringify({ version: 1, defaultProfile: "global:base" }),
		);
		writeFile(
			path.join(agentDir, "push-prompts", "profiles", "base", "prepend.md"),
			"BASE",
		);
		writeFile(
			path.join(cwd, ".pi", "push-prompts", "config.json"),
			JSON.stringify({ version: 1, defaultProfile: "project:local" }),
		);
		writeFile(
			path.join(cwd, ".pi", "push-prompts", "profiles", "local", "prepend.md"),
			"LOCAL",
		);

		const state = loadState({
			cwd,
			agentDir,
			configDirName: ".pi",
			projectTrusted: false,
		});
		assert.equal(state.globalConfig.config?.defaultProfile, "global:base");
		assert.deepEqual([...state.globalProfiles.profiles.keys()], ["base"]);
		assert.equal(state.projectConfig.exists, false);
		assert.equal(state.projectConfig.config, undefined);
		assert.equal(state.projectProfiles.profiles.size, 0);
		assert.deepEqual(state.diagnostics, []);
	});

	it("reads both scopes when the project is trusted", () => {
		const agentDir = makeDirectory("push-agent-");
		const cwd = makeDirectory("push-project-");
		writeFile(
			path.join(agentDir, "push-prompts", "config.json"),
			JSON.stringify({ version: 1 }),
		);
		writeFile(
			path.join(cwd, ".pi", "push-prompts", "config.json"),
			JSON.stringify({ version: 1, defaultProfile: "project:local" }),
		);
		writeFile(
			path.join(cwd, ".pi", "push-prompts", "profiles", "local", "prepend.md"),
			"LOCAL",
		);

		const state = loadState({
			cwd,
			agentDir,
			configDirName: ".pi",
			projectTrusted: true,
		});
		assert.equal(state.projectConfig.config?.defaultProfile, "project:local");
		assert.deepEqual([...state.projectProfiles.profiles.keys()], ["local"]);
	});

	it("collects the diagnostics of both scopes", () => {
		const agentDir = makeDirectory("push-agent-");
		const cwd = makeDirectory("push-project-");
		writeFile(
			path.join(agentDir, "push-prompts", "config.json"),
			JSON.stringify({ version: 1 }),
		);
		writeFile(
			path.join(cwd, ".pi", "push-prompts", "config.json"),
			"{ not json",
		);

		const state = loadState({
			cwd,
			agentDir,
			configDirName: ".pi",
			projectTrusted: true,
		});
		assert.deepEqual(
			state.diagnostics.map((entry) => entry.code),
			["config-parse"],
		);
	});
});

describe("readRawConfig", () => {
	it("treats a missing file as an empty version-1 config", () => {
		const file = tempConfig();
		const snapshot = readRawConfig(file);
		assert.equal(snapshot.exists, false);
		assert.equal(snapshot.text, undefined);
		assert.deepEqual(snapshot.config, { version: 1 });
	});

	it("keeps unknown keys of an existing file", () => {
		const file = tempConfig(JSON.stringify({ version: 1, custom: true }));
		const snapshot = readRawConfig(file);
		assert.equal(snapshot.exists, true);
		assert.deepEqual(snapshot.config, { version: 1, custom: true });
	});

	it("reports invalid JSON with the file path", () => {
		const file = tempConfig("{ not json");
		assert.throws(
			() => readRawConfig(file),
			(error: Error) =>
				error.message.includes(file) && /invalid JSON/.test(error.message),
		);
	});

	it("rejects a root that is not an object", () => {
		const file = tempConfig("[]");
		assert.throws(() => readRawConfig(file), /root must be a JSON object/);
	});
});

describe("writeRawConfigIfUnchanged", () => {
	it("writes and preserves unknown fields", () => {
		const file = tempConfig(JSON.stringify({ version: 1, custom: true }));
		const snapshot = readRawConfig(file);
		snapshot.config.subagents = "off";
		writeRawConfigIfUnchanged(file, snapshot, snapshot.config);
		assert.deepEqual(readJson(file), {
			version: 1,
			custom: true,
			subagents: "off",
		});
	});

	it("creates a missing file", () => {
		const file = tempConfig();
		const snapshot = readRawConfig(file);
		snapshot.config.display = "added";
		writeRawConfigIfUnchanged(file, snapshot, snapshot.config);
		assert.deepEqual(readJson(file), { version: 1, display: "added" });
	});

	it("aborts when the content changed since it was read", () => {
		const file = tempConfig(JSON.stringify({ version: 1 }));
		const snapshot = readRawConfig(file);
		fs.writeFileSync(file, JSON.stringify({ version: 1, defaultProfile: "x" }));
		assert.throws(
			() => writeRawConfigIfUnchanged(file, snapshot, snapshot.config),
			/changed on disk/,
		);
	});

	it("aborts when a missing file appeared before the write", () => {
		const file = tempConfig();
		const snapshot = readRawConfig(file);
		fs.writeFileSync(file, JSON.stringify({ version: 1 }));
		assert.throws(
			() => writeRawConfigIfUnchanged(file, snapshot, snapshot.config),
			/appeared on disk/,
		);
	});

	it("writes when only the timestamp changed", () => {
		const file = tempConfig(JSON.stringify({ version: 1 }));
		const snapshot = readRawConfig(file);
		fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
		snapshot.config.display = "added";
		writeRawConfigIfUnchanged(file, snapshot, snapshot.config);
		assert.deepEqual(readJson(file), { version: 1, display: "added" });
	});
});
