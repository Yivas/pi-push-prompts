import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ResolveSources, resolveProfile } from "../../src/core/resolve.ts";
import type { ConfigV1, ProfileCatalog } from "../../src/core/types.ts";
import { catalog, sourceConfig } from "./helpers.ts";

function build(options: {
	globalConfig?: ConfigV1;
	projectConfig?: ConfigV1;
	projectTrusted?: boolean;
	globalProfiles?: ProfileCatalog;
	projectProfiles?: ProfileCatalog;
}): ResolveSources {
	return {
		global: sourceConfig("global", options.globalConfig),
		project: sourceConfig("project", options.projectConfig),
		globalProfiles: options.globalProfiles ?? catalog("global", []),
		projectProfiles: options.projectProfiles ?? catalog("project", []),
		projectTrusted: options.projectTrusted ?? false,
	};
}

const model = { provider: "deepseek", id: "deepseek-chat" };

function diagnosticCodes(resolution: { diagnostics: { code: string }[] }) {
	return resolution.diagnostics.map((entry) => entry.code);
}

describe("resolveProfile", () => {
	it("returns off without touching profiles", () => {
		const resolution = resolveProfile({ mode: "off" }, model, build({}));
		assert.equal(resolution.mode, "off");
		assert.equal(resolution.profile, undefined);
	});

	it("uses the global default when nothing else matches", () => {
		const sources = build({
			globalConfig: {
				version: 1,
				selection: { mode: "auto" },
				defaultProfile: "global:base",
			},
			globalProfiles: catalog("global", [{ id: "base", prepend: "BASE" }]),
		});
		const resolution = resolveProfile({ mode: "auto" }, model, sources);
		assert.deepEqual(resolution.profile?.ref, { scope: "global", id: "base" });
	});

	it("prefers an explicit binding over a default", () => {
		const sources = build({
			globalConfig: {
				version: 1,
				defaultProfile: "global:base",
				bindings: [
					{
						id: "ds",
						profile: "global:deepseek",
						match: [{ provider: "deepseek", model: "*" }],
					},
				],
			},
			globalProfiles: catalog("global", [
				{ id: "base", prepend: "BASE" },
				{ id: "deepseek", prepend: "DS" },
			]),
		});
		const resolution = resolveProfile({ mode: "auto" }, model, sources);
		assert.equal(resolution.profile?.ref.id, "deepseek");
		assert.equal(resolution.binding?.binding.id, "ds");
	});

	it("lets a project binding win over a global binding", () => {
		const sources = build({
			projectTrusted: true,
			globalConfig: {
				version: 1,
				bindings: [
					{ id: "g", profile: "global:base", match: [{ provider: "*" }] },
				],
			},
			projectConfig: {
				version: 1,
				bindings: [
					{ id: "p", profile: "project:local", match: [{ provider: "*" }] },
				],
			},
			globalProfiles: catalog("global", [{ id: "base", prepend: "BASE" }]),
			projectProfiles: catalog("project", [{ id: "local", prepend: "LOCAL" }]),
		});
		assert.equal(
			resolveProfile({ mode: "auto" }, model, sources).profile?.ref.id,
			"local",
		);
	});

	it("ignores project resources when the project is untrusted", () => {
		const sources = build({
			projectTrusted: false,
			globalConfig: {
				version: 1,
				bindings: [
					{ id: "g", profile: "global:base", match: [{ provider: "*" }] },
				],
			},
			projectConfig: {
				version: 1,
				bindings: [
					{ id: "p", profile: "project:local", match: [{ provider: "*" }] },
				],
			},
			globalProfiles: catalog("global", [{ id: "base", prepend: "BASE" }]),
			projectProfiles: catalog("project", [{ id: "local", prepend: "LOCAL" }]),
		});
		assert.equal(
			resolveProfile({ mode: "auto" }, model, sources).profile?.ref.id,
			"base",
		);
	});

	it("breaks ties by specificity", () => {
		const sources = build({
			globalConfig: {
				version: 1,
				bindings: [
					{
						id: "provider-only",
						profile: "global:base",
						match: [{ provider: "deepseek" }],
					},
					{
						id: "model-only",
						profile: "global:ds",
						match: [{ model: "deepseek-chat" }],
					},
				],
			},
			globalProfiles: catalog("global", [
				{ id: "base", prepend: "BASE" },
				{ id: "ds", prepend: "DS" },
			]),
		});
		assert.equal(
			resolveProfile({ mode: "auto" }, model, sources).profile?.ref.id,
			"ds",
		);
	});

	it("lets priority beat specificity", () => {
		const sources = build({
			globalConfig: {
				version: 1,
				bindings: [
					{
						id: "specific",
						profile: "global:ds",
						match: [{ provider: "deepseek", model: "deepseek-chat" }],
					},
					{
						id: "priority",
						priority: 5,
						profile: "global:base",
						match: [{ provider: "*" }],
					},
				],
			},
			globalProfiles: catalog("global", [
				{ id: "base", prepend: "BASE" },
				{ id: "ds", prepend: "DS" },
			]),
		});
		assert.equal(
			resolveProfile({ mode: "auto" }, model, sources).profile?.ref.id,
			"base",
		);
	});

	it("reports a conflict instead of choosing by order", () => {
		const sources = build({
			globalConfig: {
				version: 1,
				bindings: [
					{
						id: "a",
						profile: "global:x",
						match: [{ provider: "deepseek", model: "deepseek-chat" }],
					},
					{
						id: "b",
						profile: "global:y",
						match: [{ provider: "deepseek", model: "deepseek-chat" }],
					},
				],
			},
			globalProfiles: catalog("global", [
				{ id: "x", prepend: "X" },
				{ id: "y", prepend: "Y" },
			]),
		});
		const resolution = resolveProfile({ mode: "auto" }, model, sources);
		assert.equal(resolution.profile, undefined);
		assert.ok(diagnosticCodes(resolution).includes("binding-conflict"));
	});

	it("does not fall back to global bindings when project rules conflict", () => {
		const sources = build({
			projectTrusted: true,
			globalConfig: {
				version: 1,
				bindings: [
					{ id: "g", profile: "global:base", match: [{ provider: "*" }] },
				],
			},
			projectConfig: {
				version: 1,
				bindings: [
					{
						id: "a",
						profile: "project:x",
						match: [{ provider: "deepseek", model: "deepseek-chat" }],
					},
					{
						id: "b",
						profile: "project:y",
						match: [{ provider: "deepseek", model: "deepseek-chat" }],
					},
				],
			},
			globalProfiles: catalog("global", [{ id: "base", prepend: "BASE" }]),
			projectProfiles: catalog("project", [
				{ id: "x", prepend: "X" },
				{ id: "y", prepend: "Y" },
			]),
		});
		const resolution = resolveProfile({ mode: "auto" }, model, sources);
		assert.equal(resolution.profile, undefined);
		assert.ok(diagnosticCodes(resolution).includes("binding-conflict"));
	});

	it("still applies a project default after a local conflict, with the diagnostic", () => {
		const sources = build({
			projectTrusted: true,
			projectConfig: {
				version: 1,
				defaultProfile: "project:fallback",
				bindings: [
					{
						id: "a",
						profile: "project:x",
						match: [{ provider: "deepseek", model: "deepseek-chat" }],
					},
					{
						id: "b",
						profile: "project:y",
						match: [{ provider: "deepseek", model: "deepseek-chat" }],
					},
				],
			},
			projectProfiles: catalog("project", [
				{ id: "x", prepend: "X" },
				{ id: "y", prepend: "Y" },
				{ id: "fallback", prepend: "FALLBACK" },
			]),
		});
		const resolution = resolveProfile({ mode: "auto" }, model, sources);
		assert.equal(resolution.profile?.ref.id, "fallback");
		assert.deepEqual(diagnosticCodes(resolution), ["binding-conflict"]);
	});

	it("honors inheritGlobalBindings: false", () => {
		const sources = build({
			projectTrusted: true,
			globalConfig: {
				version: 1,
				bindings: [
					{ id: "g", profile: "global:base", match: [{ provider: "*" }] },
				],
			},
			projectConfig: {
				version: 1,
				inheritGlobalBindings: false,
				defaultProfile: "project:local",
			},
			globalProfiles: catalog("global", [{ id: "base", prepend: "BASE" }]),
			projectProfiles: catalog("project", [{ id: "local", prepend: "LOCAL" }]),
		});
		assert.equal(
			resolveProfile({ mode: "auto" }, model, sources).profile?.ref.id,
			"local",
		);
	});

	it("matches a slash inside a model id", () => {
		const sources = build({
			globalConfig: {
				version: 1,
				bindings: [
					{
						id: "ds",
						profile: "global:ds",
						match: [{ provider: "openrouter", model: "deepseek/*" }],
					},
				],
			},
			globalProfiles: catalog("global", [{ id: "ds", prepend: "DS" }]),
		});
		const resolution = resolveProfile(
			{ mode: "auto" },
			{ provider: "openrouter", id: "deepseek/r1" },
			sources,
		);
		assert.equal(resolution.profile?.ref.id, "ds");
	});

	it("uses a manual selection regardless of the model", () => {
		const sources = build({
			globalProfiles: catalog("global", [{ id: "review", prepend: "REVIEW" }]),
		});
		const resolution = resolveProfile(
			{ mode: "manual", profile: "global:review" },
			{ provider: "x", id: "y" },
			sources,
		);
		assert.equal(resolution.mode, "manual");
		assert.equal(resolution.profile?.ref.id, "review");
	});

	it("rejects an invalid manual reference", () => {
		const resolution = resolveProfile(
			{ mode: "manual", profile: "../escape" },
			model,
			build({}),
		);
		assert.equal(resolution.profile, undefined);
		assert.deepEqual(diagnosticCodes(resolution), ["selection-invalid"]);
	});

	it("applies nothing when nothing matches", () => {
		const sources = build({ globalConfig: { version: 1 } });
		const resolution = resolveProfile({ mode: "auto" }, model, sources);
		assert.equal(resolution.profile, undefined);
		assert.equal(resolution.mode, "auto");
		assert.deepEqual(diagnosticCodes(resolution), ["auto-none"]);
	});

	it("waits instead of failing when no model is selected", () => {
		const resolution = resolveProfile({ mode: "auto" }, undefined, build({}));
		assert.equal(resolution.profile, undefined);
		assert.deepEqual(diagnosticCodes(resolution), ["auto-no-model"]);
	});

	it("skips the default profile when only bindings count", () => {
		const sources = build({
			globalConfig: { version: 1, defaultProfile: "global:base" },
			globalProfiles: catalog("global", [{ id: "base", prepend: "BASE" }]),
		});
		assert.equal(
			resolveProfile({ mode: "auto" }, model, sources).profile?.ref.id,
			"base",
		);
		assert.equal(
			resolveProfile({ mode: "auto" }, model, sources, { bindingsOnly: true })
				.profile,
			undefined,
		);
	});

	it("still applies an explicit binding when only bindings count", () => {
		const sources = build({
			globalConfig: {
				version: 1,
				defaultProfile: "global:base",
				bindings: [
					{
						id: "ds",
						profile: "global:deepseek",
						match: [{ provider: "deepseek", model: "deepseek-*" }],
					},
				],
			},
			globalProfiles: catalog("global", [
				{ id: "base", prepend: "BASE" },
				{ id: "deepseek", prepend: "DS" },
			]),
		});
		const resolution = resolveProfile({ mode: "auto" }, model, sources, {
			bindingsOnly: true,
		});
		assert.equal(resolution.profile?.ref.id, "deepseek");
	});
});
