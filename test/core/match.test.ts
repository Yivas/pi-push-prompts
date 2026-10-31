import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { globMatch, matchRule, ruleSpecificity } from "../../src/core/match.ts";

describe("globMatch", () => {
	it("matches exact strings only", () => {
		assert.equal(globMatch("deepseek", "deepseek"), true);
		assert.equal(globMatch("deepseek", "deepseek-chat"), false);
		assert.equal(globMatch("deepseek", "deep"), false);
	});

	it("treats a lone star as everything", () => {
		assert.equal(globMatch("*", "anything/with/slashes"), true);
	});

	it("lets the star cross slashes in a model id", () => {
		assert.equal(globMatch("deepseek/*", "deepseek/chat"), true);
		assert.equal(globMatch("deepseek/*", "deepseek/a/b"), true);
		assert.equal(globMatch("deepseek/*", "deepseek"), false);
	});

	it("escapes regular-expression characters", () => {
		assert.equal(globMatch("gpt-5.2", "gpt-5.2"), true);
		assert.equal(globMatch("gpt-5.2", "gpt-5x2"), false);
		assert.equal(globMatch("a+b", "a+b"), true);
		assert.equal(globMatch("a+b", "aab"), false);
	});
});

describe("ruleSpecificity", () => {
	it("ranks exact fields above wildcards", () => {
		assert.equal(
			ruleSpecificity({ provider: "openrouter", model: "deepseek/r1" }),
			3,
		);
		assert.equal(ruleSpecificity({ model: "deepseek/r1" }), 2);
		assert.equal(ruleSpecificity({ provider: "openrouter" }), 1);
		assert.equal(ruleSpecificity({}), 0);
	});

	it("combines provider and model with AND", () => {
		assert.equal(
			matchRule(
				{ provider: "openrouter", model: "deepseek/r1" },
				{ provider: "openrouter", id: "deepseek/r1" },
			),
			true,
		);
		assert.equal(
			matchRule(
				{ provider: "openrouter", model: "deepseek/r1" },
				{ provider: "deepseek", id: "deepseek/r1" },
			),
			false,
		);
	});
});
