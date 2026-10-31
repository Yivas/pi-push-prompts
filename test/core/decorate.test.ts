import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decorate } from "../../src/core/decorate.ts";
import type { ContentBlock } from "../../src/core/types.ts";
import { layer } from "./helpers.ts";

const image: ContentBlock = {
	type: "image",
	data: "QUJD",
	mimeType: "image/png",
};

describe("decorate", () => {
	it("returns undefined when neither side holds text", () => {
		assert.equal(decorate("Hello.", [layer("review", "", "")]), undefined);
		assert.equal(decorate("Hello.", []), undefined);
	});

	it("wraps a string message with the prepend and the append", () => {
		const decoration = decorate("Hello user.", [layer("review", "P", "S")]);
		assert.deepEqual(decoration, {
			content: "P\n\nHello user.\n\nS",
			insertedPrefix: "P\n\n",
			insertedSuffix: "\n\nS",
			shape: { content: "string" },
		});
	});

	it("adds only the side that holds text, without a stray separator", () => {
		assert.deepEqual(decorate("Hello user.", [layer("review", "P", "")]), {
			content: "P\n\nHello user.",
			insertedPrefix: "P\n\n",
			insertedSuffix: "",
			shape: { content: "string" },
		});
		assert.deepEqual(decorate("Hello user.", [layer("review", "", "S")]), {
			content: "Hello user.\n\nS",
			insertedPrefix: "",
			insertedSuffix: "\n\nS",
			shape: { content: "string" },
		});
	});

	it("joins inheritance from the root parent down to the specific profile", () => {
		const layers = [
			layer("child", "CHILD", "CHILD-TAIL"),
			layer("parent", "PARENT", "PARENT-TAIL"),
		];
		assert.equal(
			decorate("Hello.", layers)?.content,
			"PARENT\n\nCHILD\n\nHello.\n\nPARENT-TAIL\n\nCHILD-TAIL",
		);
	});

	it("removes a BOM, converts CRLF and drops one trailing newline", () => {
		assert.equal(
			decorate("Hello.", [layer("x", "\uFEFFline one\r\nline two\r\n")])
				?.content,
			"line one\nline two\n\nHello.",
		);
		assert.equal(
			decorate("Hello.", [layer("x", "P\n\n")])?.content,
			"P\n\n\nHello.",
		);
	});

	it("never trims or normalizes the user text", () => {
		assert.equal(
			decorate("  keep  \n", [layer("x", "P", "S")])?.content,
			"P\n\n  keep  \n\n\nS",
		);
	});

	it("merges into the first and last text blocks and leaves the middle alone", () => {
		const content: ContentBlock[] = [
			{ type: "text", text: "one", cache_control: { type: "ephemeral" } },
			image,
			{ type: "text", text: "two" },
		];
		const decoration = decorate(content, [layer("review", "P", "S")]);
		assert.deepEqual(decoration?.content, [
			{ type: "text", text: "P\n\none", cache_control: { type: "ephemeral" } },
			image,
			{ type: "text", text: "two\n\nS" },
		]);
		assert.deepEqual(decoration?.shape, {
			content: "array",
			prefix: "merged",
			suffix: "merged",
		});
		assert.equal(decoration?.insertedPrefix, "P\n\n");
		assert.equal(decoration?.insertedSuffix, "\n\nS");
	});

	it("inserts a new leading text block before a leading image", () => {
		const content: ContentBlock[] = [image, { type: "text", text: "Hello." }];
		const decoration = decorate(content, [layer("review", "P", "S")]);
		assert.deepEqual(decoration?.content, [
			{ type: "text", text: "P\n\n" },
			image,
			{ type: "text", text: "Hello.\n\nS" },
		]);
		assert.deepEqual(decoration?.shape, {
			content: "array",
			prefix: "new-block",
			suffix: "merged",
		});
	});

	it("inserts a new trailing text block after a trailing image", () => {
		const content: ContentBlock[] = [{ type: "text", text: "Hello." }, image];
		const decoration = decorate(content, [layer("review", "P", "S")]);
		assert.deepEqual(decoration?.content, [
			{ type: "text", text: "P\n\nHello." },
			image,
			{ type: "text", text: "\n\nS" },
		]);
		assert.deepEqual(decoration?.shape, {
			content: "array",
			prefix: "merged",
			suffix: "new-block",
		});
	});

	it("does not mutate the content it is given", () => {
		const content: ContentBlock[] = [
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
		];
		const before = structuredClone(content);
		const decoration = decorate(content, [layer("review", "P", "S")]);
		assert.deepEqual(content, before);
		assert.notEqual(decoration?.content, content);
	});
});
