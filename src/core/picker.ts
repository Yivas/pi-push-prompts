/**
 * Derived from pi-prompt-profiles src/core/picker.ts at 3f6d583 (MIT).
 *
 * Pure helpers behind the interactive picker: which providers and models the
 * registry offers, the text filter, and the slice of rows that fits on screen.
 */

import type { ModelIdentity } from "./types.ts";

/** A single choice shown by the picker. */
export interface PickerItem {
	value: string;
	label: string;
}

/** Unique provider names, sorted, from the models the registry offers. */
export function providerNames(models: readonly ModelIdentity[]): string[] {
	return [...new Set(models.map((model) => model.provider))].sort((a, b) =>
		a.localeCompare(b),
	);
}

/** Models of one provider, sorted by id. */
export function modelsOfProvider(
	models: readonly ModelIdentity[],
	provider: string,
): ModelIdentity[] {
	return models
		.filter((model) => model.provider === provider)
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** Every model, sorted by provider then id, for the "any provider" step. */
export function allModels(models: readonly ModelIdentity[]): ModelIdentity[] {
	return [...models].sort((a, b) => {
		const byProvider = a.provider.localeCompare(b.provider);
		return byProvider !== 0 ? byProvider : a.id.localeCompare(b.id);
	});
}

function matchesQuery(text: string, query: string): boolean {
	return text.toLowerCase().includes(query.trim().toLowerCase());
}

/** Keeps the items whose label or value contains the query, order preserved. */
export function filterItems(
	items: readonly PickerItem[],
	query: string,
): PickerItem[] {
	if (query.trim() === "") {
		return [...items];
	}
	return items.filter(
		(item) =>
			matchesQuery(item.label, query) || matchesQuery(item.value, query),
	);
}

/**
 * Visible window for a list of `total` items around `selected`, holding at most
 * `maxVisible` entries. Pi's own selector renders every option, so the caller
 * must keep the slice short.
 */
export function visibleWindow(
	total: number,
	selected: number,
	maxVisible: number,
): { start: number; end: number } {
	if (total <= maxVisible) {
		return { start: 0, end: total };
	}
	const clamped = Math.min(Math.max(selected, 0), total - 1);
	const start = Math.min(
		Math.max(clamped - Math.floor(maxVisible / 2), 0),
		total - maxVisible,
	);
	return { start, end: start + maxVisible };
}
