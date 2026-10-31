import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfigFile } from "../../src/core/config.ts";

const directories: string[] = [];

function writeConfig(contents: string | undefined): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "push-config-"));
	directories.push(directory);
	const file = path.join(directory, "config.json");
	if (contents !== undefined) {
		fs.writeFileSync(file, contents);
	}
	return file;
}

function codes(fileContents: string | undefined) {
	return loadConfigFile(writeConfig(fileContents), "global").diagnostics.map(
		(entry) => entry.code,
	);
}

afterEach(() => {
	for (const directory of directories) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	directories.length = 0;
});

describe("loadConfigFile", () => {
	it("treats a missing file as normal", () => {
		const result = loadConfigFile(writeConfig(undefined), "global");
		assert.equal(result.exists, false);
		assert.equal(result.config, undefined);
		assert.deepEqual(result.diagnostics, []);
	});

	it("parses a valid config and keeps references raw", () => {
		const result = loadConfigFile(
			writeConfig(
				JSON.stringify({
					version: 1,
					selection: { mode: "auto" },
					defaultProfile: "global:base",
					display: "added",
					bindings: [
						{
							id: "ds",
							profile: "global:deepseek",
							priority: 1,
							match: [{ provider: "deepseek", model: "*" }],
						},
					],
				}),
			),
			"global",
		);
		assert.deepEqual(result.diagnostics, []);
		assert.equal(result.config?.defaultProfile, "global:base");
		assert.equal(result.config?.bindings?.[0]?.id, "ds");
		assert.equal(result.config?.display, "added");
	});

	it("handles a UTF-8 BOM", () => {
		const result = loadConfigFile(
			writeConfig(`\uFEFF${JSON.stringify({ version: 1 })}`),
			"global",
		);
		assert.equal(result.config?.version, 1);
		assert.deepEqual(result.diagnostics, []);
	});

	it("reports invalid JSON", () => {
		assert.deepEqual(codes("{ not json"), ["config-parse"]);
	});

	it("rejects an unsupported version", () => {
		const result = loadConfigFile(
			writeConfig(JSON.stringify({ version: 2, defaultProfile: "global:x" })),
			"global",
		);
		assert.equal(result.config, undefined);
		assert.deepEqual(
			result.diagnostics.map((entry) => entry.code),
			["config-version"],
		);
	});

	it("rejects an invalid selection", () => {
		assert.deepEqual(
			codes(JSON.stringify({ version: 1, selection: { mode: "sometimes" } })),
			["config-selection"],
		);
	});

	it("drops a binding with an invalid profile reference", () => {
		const result = loadConfigFile(
			writeConfig(
				JSON.stringify({
					version: 1,
					bindings: [
						{ id: "x", profile: "../escape", match: [{ provider: "*" }] },
					],
				}),
			),
			"global",
		);
		assert.deepEqual(result.config?.bindings, []);
		assert.deepEqual(
			result.diagnostics.map((entry) => entry.code),
			["config-binding-profile"],
		);
	});

	it("drops a rule with an invalid field instead of widening it", () => {
		const result = loadConfigFile(
			writeConfig(
				JSON.stringify({
					version: 1,
					bindings: [
						{ id: "x", profile: "global:base", match: [{ provider: 123 }] },
					],
				}),
			),
			"global",
		);
		assert.deepEqual(result.config?.bindings, []);
		assert.deepEqual(
			result.diagnostics.map((entry) => entry.code),
			["config-binding-match"],
		);
	});

	it("warns that inheritGlobalBindings is project-only", () => {
		assert.deepEqual(
			codes(JSON.stringify({ version: 1, inheritGlobalBindings: false })),
			["config-inherit"],
		);
	});

	it("accepts every subagent policy value", () => {
		for (const value of ["off", "bindings", "inherit"]) {
			const result = loadConfigFile(
				writeConfig(JSON.stringify({ version: 1, subagents: value })),
				"global",
			);
			assert.equal(result.config?.subagents, value);
			assert.deepEqual(result.diagnostics, []);
		}
	});

	it("ignores an invalid subagent policy with a warning", () => {
		const result = loadConfigFile(
			writeConfig(JSON.stringify({ version: 1, subagents: "always" })),
			"global",
		);
		assert.equal(result.config?.subagents, undefined);
		assert.deepEqual(
			result.diagnostics.map((entry) => entry.code),
			["config-subagents"],
		);
	});

	it("accepts both display values and ignores any other", () => {
		for (const value of ["hidden", "added"]) {
			const result = loadConfigFile(
				writeConfig(JSON.stringify({ version: 1, display: value })),
				"global",
			);
			assert.equal(result.config?.display, value);
			assert.deepEqual(result.diagnostics, []);
		}
		const invalid = loadConfigFile(
			writeConfig(JSON.stringify({ version: 1, display: "always" })),
			"global",
		);
		assert.equal(invalid.config?.display, undefined);
		assert.deepEqual(
			invalid.diagnostics.map((entry) => entry.code),
			["config-display"],
		);
	});

	it("warns about unknown keys without dropping the rest", () => {
		const result = loadConfigFile(
			writeConfig(
				JSON.stringify({ version: 1, custom: true, defaultProfile: "base" }),
			),
			"global",
		);
		assert.equal(result.config?.defaultProfile, "base");
		assert.deepEqual(
			result.diagnostics.map((entry) => entry.code),
			["config-unknown"],
		);
	});
});
