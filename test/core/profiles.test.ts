import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	APPEND_FILE,
	DEFAULT_MAX_PROFILE_BYTES,
	loadProfiles,
	PREPEND_FILE,
} from "../../src/core/profiles.ts";

const directories: string[] = [];

function makeRoot(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-profiles-"));
	directories.push(root);
	fs.mkdirSync(path.join(root, "profiles"), { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(root, "profiles", name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	return root;
}

afterEach(() => {
	for (const directory of directories) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	directories.length = 0;
});

function codes(root: string): string[] {
	return loadProfiles(root, "global", undefined).createDiagnostics.map(
		(entry) => entry.code,
	);
}

describe("loadProfiles", () => {
	it("uses the directory name as the id and keeps both files as read", () => {
		const root = makeRoot({
			[`base/${PREPEND_FILE}`]: "\uFEFFline one\r\nline two\r\n",
			[`base/${APPEND_FILE}`]: "close\n",
		});
		const catalog = loadProfiles(root, "global", undefined);
		assert.deepEqual([...catalog.profiles.keys()], ["base"]);
		const profile = catalog.profiles.get("base");
		assert.equal(profile?.prepend, "line one\r\nline two\r\n");
		assert.equal(profile?.append, "close\n");
		assert.deepEqual(catalog.createDiagnostics, []);
	});

	it("accepts a profile with only one of the two text files", () => {
		const root = makeRoot({ [`only-append/${APPEND_FILE}`]: "tail" });
		const catalog = loadProfiles(root, "global", undefined);
		const profile = catalog.profiles.get("only-append");
		assert.equal(profile?.prepend, "");
		assert.equal(profile?.append, "tail");
	});

	it("takes the description from the config metadata", () => {
		const root = makeRoot({ [`base/${PREPEND_FILE}`]: "x" });
		const catalog = loadProfiles(root, "global", {
			base: { description: "Base rules" },
		});
		assert.equal(catalog.profiles.get("base")?.description, "Base rules");
	});

	it("skips a profile whose text files hold nothing", () => {
		const root = makeRoot({
			[`empty/${PREPEND_FILE}`]: "",
			[`empty/${APPEND_FILE}`]: "\n",
		});
		const catalog = loadProfiles(root, "global", undefined);
		assert.equal(catalog.profiles.size, 0);
		assert.deepEqual(
			catalog.createDiagnostics.map((entry) => entry.code),
			["profile-empty"],
		);
	});

	it("skips a directory whose name is not a safe id", () => {
		const root = makeRoot({ [`not a profile/${PREPEND_FILE}`]: "x" });
		assert.deepEqual(codes(root), ["profile-id"]);
	});

	it("skips an oversized text file", () => {
		const root = makeRoot({ [`big/${PREPEND_FILE}`]: "a".repeat(100) });
		const catalog = loadProfiles(root, "global", undefined, 10);
		assert.equal(catalog.profiles.size, 0);
		assert.deepEqual(
			catalog.createDiagnostics.map((entry) => entry.code),
			["profile-too-large"],
		);
	});

	it("accepts a text file exactly at the size limit", () => {
		const text = "a".repeat(DEFAULT_MAX_PROFILE_BYTES);
		const root = makeRoot({ [`limit/${PREPEND_FILE}`]: text });
		const catalog = loadProfiles(root, "global", undefined);
		assert.equal(catalog.profiles.get("limit")?.prepend, text);
	});

	it("refuses a text file that resolves outside the root", (t) => {
		const root = makeRoot({ [`base/${APPEND_FILE}`]: "x" });
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "push-outside-"));
		directories.push(outside);
		const secret = path.join(outside, "secret.md");
		fs.writeFileSync(secret, "external text");
		try {
			fs.symlinkSync(
				secret,
				path.join(root, "profiles", "base", PREPEND_FILE),
				"file",
			);
		} catch {
			t.skip("this user cannot create symlinks");
			return;
		}
		const catalog = loadProfiles(root, "global", undefined);
		assert.equal(catalog.profiles.size, 0);
		assert.deepEqual(
			catalog.createDiagnostics.map((entry) => entry.code),
			["profile-symlink"],
		);
	});

	it("returns an empty catalog when profiles/ is absent", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-empty-"));
		directories.push(root);
		const catalog = loadProfiles(root, "global", undefined);
		assert.equal(catalog.profiles.size, 0);
		assert.deepEqual(catalog.createDiagnostics, []);
	});
});
