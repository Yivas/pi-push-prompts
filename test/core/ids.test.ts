import "../support/pinned-pi-package.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSafeId, MAX_ID_LENGTH, suggestId } from "../../src/core/ids.ts";

describe("push-prompts: the id offered for a typed name", () => {
	it("lowercases words and joins them with one separator", () => {
		assert.equal(suggestId("Pensamiento abstracto"), "pensamiento-abstracto");
		assert.equal(suggestId("  code   review  "), "code-review");
	});

	it("folds accents and drops the combining marks", () => {
		assert.equal(suggestId("Programación en español"), "programacion-en-espanol");
		assert.equal(suggestId("Über ñandú"), "uber-nandu");
	});

	it("keeps the characters an id may hold", () => {
		assert.equal(suggestId("my.profile"), "my.profile");
		assert.equal(suggestId("v2_beta-1"), "v2_beta-1");
	});

	it("starts with a letter or digit", () => {
		assert.equal(suggestId("--draft--"), "draft");
		assert.equal(suggestId(".hidden"), "hidden");
		assert.equal(suggestId("123 notas"), "123-notas");
	});

	it("never leaves a traversal segment", () => {
		assert.equal(suggestId(".."), "");
		assert.equal(suggestId("a..b"), "a.b");
		assert.equal(suggestId("../../etc"), "etc");
	});

	it("caps the id at the length the loader accepts", () => {
		const long = suggestId("a".repeat(200));
		assert.equal(long.length, MAX_ID_LENGTH);
		assert.equal(isSafeId(long), true);
		// A separator at the cut is removed, so the id does not end with one.
		assert.equal(suggestId(`${"a".repeat(63)} b`), "a".repeat(63));
	});

	it("returns nothing when no id can be derived", () => {
		assert.equal(suggestId("!!!"), "");
		assert.equal(suggestId("😀😀"), "");
		assert.equal(suggestId("   "), "");
		assert.equal(suggestId(""), "");
	});
});
