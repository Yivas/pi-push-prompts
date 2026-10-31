import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandProfile, type InheritDeps } from "../../src/core/inherit.ts";
import type {
	LoadedProfile,
	ProfileMeta,
	ProfileRef,
} from "../../src/core/types.ts";

interface Spec {
	prepend?: string;
	append?: string;
}

function deps(
	profiles: Record<string, Spec>,
	meta: Record<string, ProfileMeta> = {},
): InheritDeps {
	return {
		getProfile(ref: ProfileRef): LoadedProfile | undefined {
			const spec = profiles[`${ref.scope}:${ref.id}`];
			if (spec === undefined) {
				return undefined;
			}
			return {
				id: ref.id,
				scope: ref.scope,
				path: `${ref.scope}/profiles/${ref.id}`,
				prepend: spec.prepend ?? "",
				append: spec.append ?? "",
			};
		},
		getMeta(ref: ProfileRef): ProfileMeta | undefined {
			return meta[`${ref.scope}:${ref.id}`];
		},
	};
}

describe("expandProfile", () => {
	it("orders the specific profile before its base", () => {
		const result = expandProfile(
			{ scope: "global", id: "review" },
			deps(
				{
					"global:review": { prepend: "REVIEW" },
					"global:base": { prepend: "BASE" },
				},
				{ "global:review": { extends: "base" } },
			),
		);
		assert.deepEqual(
			result.profile?.layers.map((layer) => layer.ref.id),
			["review", "base"],
		);
		assert.deepEqual(
			result.profile?.layers.map((layer) => layer.prepend),
			["REVIEW", "BASE"],
		);
	});

	it("resolves a project profile into a global base", () => {
		const result = expandProfile(
			{ scope: "project", id: "local" },
			deps(
				{ "project:local": {}, "global:base": { append: "BASE" } },
				{ "project:local": { extends: "global:base" } },
			),
		);
		assert.deepEqual(
			result.profile?.layers.map((layer) => layer.ref.id),
			["local", "base"],
		);
	});

	it("detects cycles", () => {
		const result = expandProfile(
			{ scope: "global", id: "a" },
			deps(
				{ "global:a": {}, "global:b": {} },
				{ "global:a": { extends: "b" }, "global:b": { extends: "a" } },
			),
		);
		assert.equal(result.profile, undefined);
		assert.deepEqual(
			result.diagnostics.map((entry) => entry.code),
			["profile-cycle"],
		);
	});

	it("reports a missing parent", () => {
		const result = expandProfile(
			{ scope: "global", id: "review" },
			deps({ "global:review": {} }, { "global:review": { extends: "ghost" } }),
		);
		assert.equal(result.profile, undefined);
		assert.deepEqual(
			result.diagnostics.map((entry) => entry.code),
			["profile-missing"],
		);
	});

	it("enforces the depth limit", () => {
		const result = expandProfile(
			{ scope: "global", id: "a" },
			deps(
				{ "global:a": {}, "global:b": {}, "global:c": {} },
				{ "global:a": { extends: "b" }, "global:b": { extends: "c" } },
			),
			{ maxDepth: 2 },
		);
		assert.deepEqual(
			result.diagnostics.map((entry) => entry.code),
			["profile-depth"],
		);
	});

	it("counts both text files of every layer against the total limit", () => {
		const result = expandProfile(
			{ scope: "global", id: "a" },
			deps(
				{
					"global:a": { prepend: "aaaaaaaaaa" },
					"global:b": { append: "bbbbbbbbbb" },
				},
				{ "global:a": { extends: "b" } },
			),
			{ maxTotalBytes: 15 },
		);
		assert.equal(result.profile, undefined);
		assert.deepEqual(
			result.diagnostics.map((entry) => entry.code),
			["profile-total-size"],
		);
	});
});
