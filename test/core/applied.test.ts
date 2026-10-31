import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildAppliedEntry,
	contentDigest,
	createDisplayLookup,
	parseAppliedEntry,
	recoverOriginal,
} from "../../src/core/applied.ts";
import { decorate } from "../../src/core/decorate.ts";
import type {
	AppliedEntry,
	ContentBlock,
	Decoration,
} from "../../src/core/types.ts";
import { layer } from "./helpers.ts";

const image: ContentBlock = {
	type: "image",
	data: "QUJD",
	mimeType: "image/png",
};

const ref = { scope: "global", id: "review" } as const;

function decorationOf(content: string): Decoration {
	const decoration = decorate(content, [layer("review", "P", "S")]);
	if (!decoration) {
		throw new Error("fixture profile must insert text");
	}
	return decoration;
}

function entryOf(original: string, mode: "active" | "once" = "active") {
	return buildAppliedEntry({
		ref,
		mode,
		decoration: decorationOf(original),
		timestamp: 1700000000000,
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		originalContent: original,
	});
}

describe("contentDigest", () => {
	it("hashes the UTF-8 text of a string message", () => {
		assert.equal(
			contentDigest("Hello user."),
			"2187bf8cf27fee6b00a13a2ddc8ec0b9f11423e36afb2e8a094e20b86bf0f6ce",
		);
	});

	it("hashes canonical JSON of blocks with image payloads reduced to their digest", () => {
		assert.equal(
			contentDigest([{ type: "text", text: "Hello." }, image]),
			"0ad497fed60aee31b8a57b35c54970d9675a84cb3bc10e6cd2bd9f3c446277d9",
		);
	});

	it("ignores field order but distinguishes image payloads", () => {
		assert.equal(
			contentDigest([{ text: "Hello.", type: "text" }, image]),
			contentDigest([{ type: "text", text: "Hello." }, image]),
		);
		assert.notEqual(
			contentDigest([{ type: "text", text: "Hello." }, image]),
			contentDigest([
				{ type: "text", text: "Hello." },
				{ ...image, data: "REVG" },
			]),
		);
	});
});

describe("buildAppliedEntry", () => {
	it("records the applied profile, mode, inserted text and digests", () => {
		assert.deepEqual(entryOf("Hello user.", "once"), {
			schema: 1,
			profile: "global:review",
			mode: "once",
			insertedPrefix: "P\n\n",
			insertedSuffix: "\n\nS",
			shape: { content: "string" },
			timestamp: 1700000000000,
			role: "user",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			originalDigest:
				"2187bf8cf27fee6b00a13a2ddc8ec0b9f11423e36afb2e8a094e20b86bf0f6ce",
			effectiveDigest:
				"7a6626c0d5aa3ede950e2477f53b1d474f815837bf3e05fc36ab6ced92c2e9ed",
		});
	});
});

describe("parseAppliedEntry", () => {
	it("accepts the entry it built", () => {
		const entry = entryOf("Hello user.");
		assert.deepEqual(parseAppliedEntry(structuredClone(entry)), entry);
	});

	it("rejects unknown schemas, bad digests, bad shapes and non-objects", () => {
		const entry = entryOf("Hello user.");
		const broken: unknown[] = [
			undefined,
			"entry",
			{ ...entry, schema: 2 },
			{ ...entry, originalDigest: "not-a-digest" },
			{ ...entry, shape: { content: "string", prefix: "merged" } },
			{ ...entry, shape: { content: "blocks" } },
			{ ...entry, profile: "../escape" },
			{ ...entry, role: "assistant" },
		];
		for (const value of broken) {
			assert.equal(parseAppliedEntry(value), undefined);
		}
	});
});

describe("recoverOriginal", () => {
	it("returns the string message that was sent", () => {
		const entry = entryOf("Hello user.");
		assert.equal(
			recoverOriginal("P\n\nHello user.\n\nS", entry),
			"Hello user.",
		);
	});

	it("returns the blocks that were sent, images included", () => {
		const original: ContentBlock[] = [image, { type: "text", text: "Hello." }];
		const decoration = decorate(original, [layer("review", "P", "S")]);
		if (!decoration) {
			throw new Error("fixture profile must insert text");
		}
		const entry = buildAppliedEntry({
			ref,
			mode: "active",
			decoration,
			timestamp: 1,
			provider: "openai",
			model: "gpt-5",
			originalContent: original,
		});
		assert.deepEqual(recoverOriginal(decoration.content, entry), original);
	});

	it("refuses a message that changed after decoration", () => {
		const entry = entryOf("Hello user.");
		assert.equal(recoverOriginal("P\n\nHello there.\n\nS", entry), undefined);
	});

	it("refuses an entry whose recorded original does not match", () => {
		const entry = entryOf("Hello user.");
		const edited: AppliedEntry = {
			...entry,
			originalDigest: "0".repeat(64),
		};
		assert.equal(recoverOriginal("P\n\nHello user.\n\nS", edited), undefined);
	});

	it("refuses blocks that no longer start with the inserted text", () => {
		const original: ContentBlock[] = [{ type: "text", text: "Hello." }];
		const decoration = decorate(original, [layer("review", "P", "")]);
		if (!decoration) {
			throw new Error("fixture profile must insert text");
		}
		const entry = buildAppliedEntry({
			ref,
			mode: "active",
			decoration,
			timestamp: 1,
			provider: "openai",
			model: "gpt-5",
			originalContent: original,
		});
		assert.equal(
			recoverOriginal([{ type: "text", text: "Hello." }], entry),
			undefined,
		);
	});
});

describe("createDisplayLookup", () => {
	it("maps the exact effective text back to its original", () => {
		const lookup = createDisplayLookup([
			{
				entry: entryOf("Hello user."),
				effective: "P\n\nHello user.\n\nS",
				original: "Hello user.",
			},
		]);
		assert.equal(lookup("P\n\nHello user.\n\nS"), "Hello user.");
		assert.equal(lookup("Unrelated."), undefined);
	});

	it("returns the same original when records agree", () => {
		const record = {
			entry: entryOf("Hello user."),
			effective: "P\n\nHello user.\n\nS",
			original: "Hello user.",
		};
		const lookup = createDisplayLookup([record, { ...record }]);
		assert.equal(lookup("P\n\nHello user.\n\nS"), "Hello user.");
	});

	it("gives up when several entries disagree about the original", () => {
		const lookup = createDisplayLookup([
			{ entry: entryOf("Hello user."), effective: "shared", original: "A" },
			{ entry: entryOf("Other."), effective: "shared", original: "B" },
		]);
		assert.equal(lookup("shared"), undefined);
	});

	it("gives up when the effective text is itself a recorded original", () => {
		const lookup = createDisplayLookup([
			{
				entry: entryOf("shared"),
				effective: "P\n\nshared\n\nS",
				original: "shared",
			},
			{
				entry: entryOf("Other."),
				effective: "P\n\nother\n\nS",
				original: "P\n\nshared\n\nS",
			},
		]);
		assert.equal(lookup("P\n\nshared\n\nS"), undefined);
	});
});
