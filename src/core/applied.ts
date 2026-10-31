/**
 * The `push-prompts.applied` entry: what was inserted into one user message,
 * how to take it out again, and how to show the original in the native row.
 *
 * Everything here is pure. Entries come back from a session file written by an
 * older run — or edited by hand — so they are validated before use, and the
 * recovered original is accepted only when its digest matches.
 */

import { createHash } from "node:crypto";
import { formatRef, parseRef } from "./refs.ts";
import type {
	AppliedEntry,
	ContentBlock,
	Decoration,
	DecorationShape,
	ProfileRef,
	UserContent,
} from "./types.ts";

export const APPLIED_ENTRY_TYPE = "push-prompts.applied";
export const APPLIED_SCHEMA = 1;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Stable JSON: object keys sorted, undefined values omitted as `JSON.stringify`
 * does. Without it, the same blocks in a different field order would digest
 * differently and a valid message would look tampered with.
 */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		const fields = keys.map(
			(key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
		);
		return `{${fields.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * Images are reduced to the digest of their data, so the payload is identified
 * without being stored or compared as base64.
 */
function maskBlock(block: ContentBlock): unknown {
	if (block.type === "image" && typeof block.data === "string") {
		return {
			type: "image",
			sha256: sha256Hex(block.data),
			mimeType: block.mimeType,
		};
	}
	return block;
}

/** Digest of user content: UTF-8 of a string, canonical JSON of blocks. */
export function contentDigest(content: UserContent): string {
	if (typeof content === "string") {
		return sha256Hex(content);
	}
	return sha256Hex(canonicalJson(content.map(maskBlock)));
}

export interface AppliedEntryInput {
	ref: ProfileRef;
	mode: "active" | "once";
	decoration: Decoration;
	timestamp: number;
	provider: string;
	model: string;
	originalContent: UserContent;
}

export function buildAppliedEntry(input: AppliedEntryInput): AppliedEntry {
	return {
		schema: APPLIED_SCHEMA,
		profile: formatRef(input.ref),
		mode: input.mode,
		insertedPrefix: input.decoration.insertedPrefix,
		insertedSuffix: input.decoration.insertedSuffix,
		shape: input.decoration.shape,
		timestamp: input.timestamp,
		role: "user",
		provider: input.provider,
		model: input.model,
		originalDigest: contentDigest(input.originalContent),
		effectiveDigest: contentDigest(input.decoration.content),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPlacement(value: unknown): DecorationShape["prefix"] | undefined {
	if (value === "merged" || value === "new-block") {
		return value;
	}
	return undefined;
}

function readShape(value: unknown): DecorationShape | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.content === "string") {
		// A string message has no blocks, so a placement would describe text
		// inserted nowhere; recovery would then have to guess.
		if (value.prefix !== undefined || value.suffix !== undefined) {
			return undefined;
		}
		return { content: "string" };
	}
	if (value.content !== "array") {
		return undefined;
	}
	const shape: DecorationShape = { content: "array" };
	for (const side of ["prefix", "suffix"] as const) {
		const raw = value[side];
		if (raw === undefined) {
			continue;
		}
		const placement = readPlacement(raw);
		if (placement === undefined) {
			return undefined;
		}
		shape[side] = placement;
	}
	return shape;
}

/**
 * Validates an entry read back from a session. Returns `undefined` for any
 * field it cannot trust, which the caller treats as "no entry".
 */
export function parseAppliedEntry(raw: unknown): AppliedEntry | undefined {
	if (!isRecord(raw) || raw.schema !== APPLIED_SCHEMA) {
		return undefined;
	}
	if (typeof raw.profile !== "string" || !parseRef(raw.profile)) {
		return undefined;
	}
	if (raw.mode !== "active" && raw.mode !== "once") {
		return undefined;
	}
	if (typeof raw.insertedPrefix !== "string") {
		return undefined;
	}
	if (typeof raw.insertedSuffix !== "string") {
		return undefined;
	}
	const shape = readShape(raw.shape);
	if (!shape) {
		return undefined;
	}
	if (typeof raw.timestamp !== "number" || !Number.isFinite(raw.timestamp)) {
		return undefined;
	}
	if (raw.role !== "user") {
		return undefined;
	}
	if (typeof raw.provider !== "string" || typeof raw.model !== "string") {
		return undefined;
	}
	if (
		typeof raw.originalDigest !== "string" ||
		!DIGEST_PATTERN.test(raw.originalDigest)
	) {
		return undefined;
	}
	if (
		typeof raw.effectiveDigest !== "string" ||
		!DIGEST_PATTERN.test(raw.effectiveDigest)
	) {
		return undefined;
	}
	return {
		schema: APPLIED_SCHEMA,
		profile: raw.profile,
		mode: raw.mode,
		insertedPrefix: raw.insertedPrefix,
		insertedSuffix: raw.insertedSuffix,
		shape,
		timestamp: raw.timestamp,
		role: "user",
		provider: raw.provider,
		model: raw.model,
		originalDigest: raw.originalDigest,
		effectiveDigest: raw.effectiveDigest,
	};
}

function isTextBlock(block: ContentBlock): boolean {
	return block.type === "text" && typeof block.text === "string";
}

function recoverString(text: string, entry: AppliedEntry): string | undefined {
	const { insertedPrefix, insertedSuffix } = entry;
	if (!text.startsWith(insertedPrefix) || !text.endsWith(insertedSuffix)) {
		return undefined;
	}
	if (text.length < insertedPrefix.length + insertedSuffix.length) {
		return undefined;
	}
	const original = text.slice(
		insertedPrefix.length,
		text.length - insertedSuffix.length,
	);
	return contentDigest(original) === entry.originalDigest
		? original
		: undefined;
}

function recoverBlocks(
	blocks: readonly ContentBlock[],
	entry: AppliedEntry,
): readonly ContentBlock[] | undefined {
	if (entry.shape.content !== "array") {
		return undefined;
	}
	const recovered = [...blocks];

	if (entry.shape.prefix === "merged") {
		const first = recovered[0];
		if (!first || !isTextBlock(first)) {
			return undefined;
		}
		const text = first.text as string;
		if (!text.startsWith(entry.insertedPrefix)) {
			return undefined;
		}
		recovered[0] = {
			...first,
			text: text.slice(entry.insertedPrefix.length),
		};
	} else if (entry.shape.prefix === "new-block") {
		const first = recovered[0];
		if (!first || !isTextBlock(first) || first.text !== entry.insertedPrefix) {
			return undefined;
		}
		recovered.shift();
	}

	if (entry.shape.suffix === "merged") {
		const last = recovered[recovered.length - 1];
		if (!last || !isTextBlock(last)) {
			return undefined;
		}
		const text = last.text as string;
		if (!text.endsWith(entry.insertedSuffix)) {
			return undefined;
		}
		recovered[recovered.length - 1] = {
			...last,
			text: text.slice(0, text.length - entry.insertedSuffix.length),
		};
	} else if (entry.shape.suffix === "new-block") {
		const last = recovered[recovered.length - 1];
		if (!last || !isTextBlock(last) || last.text !== entry.insertedSuffix) {
			return undefined;
		}
		recovered.pop();
	}

	return contentDigest(recovered) === entry.originalDigest
		? recovered
		: undefined;
}

/**
 * Removes exactly the recorded text and returns the original message, or
 * `undefined` when anything does not match: another extension touched the
 * message, the entry belongs to a different one, or it was edited.
 */
export function recoverOriginal(
	effectiveContent: UserContent,
	entry: AppliedEntry,
): UserContent | undefined {
	return typeof effectiveContent === "string"
		? recoverString(effectiveContent, entry)
		: recoverBlocks(effectiveContent, entry);
}

/** One decorated message as the pre-existing row can see it: text only. */
export interface DisplayRecord {
	entry: AppliedEntry;
	/** Effective text Pi paints, exactly as stored. */
	effective: string;
	/** Original text this message was sent with. */
	original: string;
}

/**
 * Builds the lookup the native user row uses to paint the original instead of
 * the decorated text.
 *
 * The map is keyed by the digest of the effective text and then confirmed by
 * string equality, so a hash collision cannot substitute a different message.
 * It gives up (returns `undefined`) when the text is unknown, when several
 * entries disagree about the original, or when the text is itself the recorded
 * original of another message: in all three cases painting something would be
 * a guess.
 */
export function createDisplayLookup(
	records: readonly DisplayRecord[],
): (markdown: string) => string | undefined {
	const byDigest = new Map<string, DisplayRecord[]>();
	const originals = new Set<string>();
	for (const record of records) {
		const digest = contentDigest(record.effective);
		const bucket = byDigest.get(digest);
		if (bucket) {
			bucket.push(record);
		} else {
			byDigest.set(digest, [record]);
		}
		originals.add(record.original);
	}

	const memo = new Map<string, string | undefined>();
	return (markdown: string): string | undefined => {
		const cached = memo.get(markdown);
		if (cached !== undefined || memo.has(markdown)) {
			return cached;
		}
		const answer = resolveOriginal(markdown, byDigest, originals);
		memo.set(markdown, answer);
		return answer;
	};
}

function resolveOriginal(
	markdown: string,
	byDigest: Map<string, DisplayRecord[]>,
	originals: Set<string>,
): string | undefined {
	const bucket = byDigest.get(contentDigest(markdown));
	if (!bucket) {
		return undefined;
	}
	const matching = bucket.filter((record) => record.effective === markdown);
	if (matching.length === 0) {
		return undefined;
	}
	const distinct = new Set(matching.map((record) => record.original));
	if (distinct.size !== 1) {
		return undefined;
	}
	if (originals.has(markdown)) {
		return undefined;
	}
	return matching[0]?.original;
}
