/**
 * The published JSON Schema and the loader must make the same call on the same
 * file: every config the loader accepts without an error is valid per the
 * schema, and every config the loader rejects with an error is invalid per the
 * schema.
 *
 * The subset validator below is test-only. It reads the keywords this schema
 * uses so the test compares the file on disk with `loadConfigFile`, without
 * pulling a runtime dependency into the product.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfigFile } from "../../src/core/config.ts";
import type { Diagnostic } from "../../src/core/types.ts";

type Schema = Record<string, unknown>;

const SCHEMA = JSON.parse(
	fs.readFileSync(
		new URL("../../schema/config.schema.json", import.meta.url),
		"utf8",
	),
) as Schema;

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	directories.length = 0;
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRef(reference: string): Schema {
	const prefix = "#/$defs/";
	assert.ok(reference.startsWith(prefix), `unsupported $ref ${reference}`);
	const name = reference.slice(prefix.length);
	const defs = SCHEMA.$defs as Record<string, Schema>;
	const definition = defs[name];
	assert.ok(definition, `unknown $def ${name}`);
	return definition;
}

function typeMatches(type: unknown, value: unknown): boolean {
	switch (type) {
		case "object":
			return isRecord(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		default:
			assert.fail(`unsupported type ${String(type)}`);
	}
}

/** Validation of the keywords this schema uses; `false` means the value is invalid. */
function valid(schema: Schema, value: unknown): boolean {
	if (typeof schema.$ref === "string") {
		return valid(resolveRef(schema.$ref), value);
	}
	if (Array.isArray(schema.oneOf)) {
		const matches = (schema.oneOf as Schema[]).filter((option) =>
			valid(option, value),
		);
		if (matches.length !== 1) {
			return false;
		}
	}
	if (schema.type !== undefined && !typeMatches(schema.type, value)) {
		return false;
	}
	if ("const" in schema && value !== schema.const) {
		return false;
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		return false;
	}
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) {
			return false;
		}
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
			return false;
		}
		if (
			typeof schema.pattern === "string" &&
			!new RegExp(schema.pattern, "u").test(value)
		) {
			return false;
		}
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			return false;
		}
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			return false;
		}
		if (schema.items !== undefined) {
			const items = schema.items as Schema;
			if (!value.every((entry) => valid(items, entry))) {
				return false;
			}
		}
	}
	if (isRecord(value)) {
		const properties = (schema.properties as Record<string, Schema>) ?? {};
		const required = (schema.required as string[] | undefined) ?? [];
		for (const key of required) {
			if (!Object.hasOwn(value, key)) {
				return false;
			}
		}
		for (const [key, entry] of Object.entries(value)) {
			const propertySchema = properties[key];
			if (propertySchema) {
				if (!valid(propertySchema, entry)) {
					return false;
				}
				continue;
			}
			const additional = schema.additionalProperties;
			if (additional === false) {
				return false;
			}
			if (isRecord(additional) && !valid(additional, entry)) {
				return false;
			}
		}
	}
	return true;
}

interface Fixture {
	name: string;
	config: unknown;
}

const VALID: Fixture[] = [
	{ name: "the version alone", config: { version: 1 } },
	{
		name: "every key the loader understands",
		config: {
			version: 1,
			selection: { mode: "manual", profile: "global:base" },
			defaultProfile: "base",
			profiles: { base: {}, child: { extends: "base", description: "x" } },
			bindings: [
				{
					id: "opus",
					profile: "global:base",
					priority: 2,
					match: [{ provider: "anthropic", model: "claude-*" }, { model: "*" }],
				},
			],
			subagents: "inherit",
			display: "added",
		},
	},
	{ name: "auto selection", config: { version: 1, selection: { mode: "auto" } } },
	{ name: "off selection", config: { version: 1, selection: { mode: "off" } } },
	{ name: "hidden display", config: { version: 1, display: "hidden" } },
	{
		name: "the project-only switch",
		config: { version: 1, inheritGlobalBindings: false },
	},
	{
		name: "a key from another version of the product",
		config: { version: 1, futureKey: { nested: true } },
	},
];

const INVALID: Fixture[] = [
	{ name: "a missing version", config: {} },
	{ name: "a future version", config: { version: 2 } },
	{ name: "a root array", config: [1] },
	{ name: "a root string", config: "config" },
	{
		name: "an unknown selection mode",
		config: { version: 1, selection: { mode: "always" } },
	},
	{
		name: "a manual selection without a profile",
		config: { version: 1, selection: { mode: "manual" } },
	},
	{
		name: "a profile reference that escapes the root",
		config: { version: 1, defaultProfile: "global:../escape" },
	},
	{
		name: "profiles that are not an object",
		config: { version: 1, profiles: [] },
	},
	{
		name: "bindings that are not an array",
		config: { version: 1, bindings: {} },
	},
	{
		name: "more bindings than the loader accepts",
		config: {
			version: 1,
			bindings: Array.from({ length: 201 }, () => ({
				id: "x",
				profile: "global:base",
				match: [{ model: "*" }],
			})),
		},
	},
];

/**
 * Configs the schema rejects but the loader keeps on purpose: the file is valid
 * JSON it can still use, so one bad field is reported and dropped instead of
 * making the whole file unreadable. The schema stays strict so an editor can
 * flag the field before it is written.
 */
const LENIENT: Fixture[] = [
	{
		name: "a binding without a match rule",
		config: {
			version: 1,
			bindings: [{ id: "x", profile: "global:base" }],
		},
	},
	{
		name: "a display value the loader does not know",
		config: { version: 1, display: "sometimes" },
	},
	{
		name: "a subagent policy the loader does not know",
		config: { version: 1, subagents: "always" },
	},
];

function load(config: unknown): { diagnostics: Diagnostic[]; accepted: boolean } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "push-schema-"));
	directories.push(directory);
	const file = path.join(directory, "config.json");
	fs.writeFileSync(file, JSON.stringify(config));
	const result = loadConfigFile(file, "global");
	const errors = result.diagnostics.filter((entry) => entry.level === "error");
	return { diagnostics: result.diagnostics, accepted: errors.length === 0 };
}

describe("schema/config.schema.json", () => {
	for (const fixture of VALID) {
		it(`accepts ${fixture.name}, as the loader does`, () => {
			assert.equal(
				valid(SCHEMA, fixture.config),
				true,
				"the schema accepts the config",
			);
			const loaded = load(fixture.config);
			assert.equal(
				loaded.accepted,
				true,
				`the loader reports no error: ${loaded.diagnostics.map((entry) => entry.message).join("; ")}`,
			);
		});
	}

	for (const fixture of INVALID) {
		it(`rejects ${fixture.name}, as the loader does`, () => {
			assert.equal(
				valid(SCHEMA, fixture.config),
				false,
				"the schema rejects the config",
			);
			const loaded = load(fixture.config);
			assert.equal(
				loaded.accepted,
				false,
				"the loader reports an error",
			);
		});
	}

	for (const fixture of LENIENT) {
		it(`reports ${fixture.name} without discarding the file`, () => {
			assert.equal(
				valid(SCHEMA, fixture.config),
				false,
				"the schema rejects the config",
			);
			const loaded = load(fixture.config);
			assert.equal(
				loaded.accepted,
				true,
				"the loader keeps working with what it could read",
			);
			assert.ok(
				loaded.diagnostics.some((entry) => entry.level === "warn"),
				"the loader says why the field was dropped",
			);
		});
	}
});
