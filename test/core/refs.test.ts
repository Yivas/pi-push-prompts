import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSafeId } from "../../src/core/ids.ts";
import { formatRef, parseRef, resolveRef } from "../../src/core/refs.ts";

describe("isSafeId", () => {
	it("accepts simple ids", () => {
		assert.equal(isSafeId("base"), true);
		assert.equal(isSafeId("review-v2"), true);
		assert.equal(isSafeId("gpt_5.2"), true);
	});

	it("rejects paths and traversal", () => {
		assert.equal(isSafeId("../escape"), false);
		assert.equal(isSafeId("a/b"), false);
		assert.equal(isSafeId("a\\b"), false);
		assert.equal(isSafeId(".hidden"), false);
		assert.equal(isSafeId(""), false);
		assert.equal(isSafeId("a..b"), false);
	});

	it("rejects ids longer than the limit", () => {
		assert.equal(isSafeId("a".repeat(64)), true);
		assert.equal(isSafeId("a".repeat(65)), false);
	});
});

describe("profile references", () => {
	it("parses explicit scopes", () => {
		assert.deepEqual(parseRef("global:base"), { scope: "global", id: "base" });
		assert.deepEqual(parseRef("project:base"), {
			scope: "project",
			id: "base",
		});
		assert.equal(parseRef("local:base"), undefined);
		assert.equal(parseRef("global:../x"), undefined);
	});

	it("normalizes a bare id inside a default scope", () => {
		assert.deepEqual(resolveRef("review", "project"), {
			scope: "project",
			id: "review",
		});
		assert.deepEqual(resolveRef("global:review", "project"), {
			scope: "global",
			id: "review",
		});
		assert.deepEqual(resolveRef(" global:review ", "project"), {
			scope: "global",
			id: "review",
		});
	});

	it("rejects an unknown scope or an unsafe id", () => {
		assert.equal(resolveRef("weird:review", "global"), undefined);
		assert.equal(resolveRef("a/b", "global"), undefined);
		assert.equal(resolveRef("global:a:b", "global"), undefined);
	});

	it("formats references", () => {
		assert.equal(formatRef({ scope: "global", id: "base" }), "global:base");
	});
});
