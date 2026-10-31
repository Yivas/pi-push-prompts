/**
 * Derived from pi-prompt-profiles src/core/match.ts at 3f6d583 (MIT).
 */

import type {
	Binding,
	BindingMatch,
	MatchRule,
	ModelIdentity,
	Scope,
} from "./types.ts";

/**
 * A single `*` matches any run of characters, including `/`, so `deepseek/*`
 * matches `deepseek/chat` and `deepseek/a/b`. There are no other wildcards and
 * no regular expressions. Matching is full string.
 */
const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g;

export function globMatch(pattern: string, value: string): boolean {
	if (pattern === "*") {
		return true;
	}
	if (!pattern.includes("*")) {
		return pattern === value;
	}
	const escaped = pattern.replace(REGEX_SPECIALS, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

function fieldMatches(pattern: string | undefined, value: string): boolean {
	return pattern === undefined ? true : globMatch(pattern, value);
}

function isExact(pattern: string | undefined): boolean {
	return pattern !== undefined && !pattern.includes("*");
}

/** 3 = provider and model exact; 2 = model exact only; 1 = provider exact only; 0 = both patterns. */
export function ruleSpecificity(rule: MatchRule): number {
	const providerExact = isExact(rule.provider);
	const modelExact = isExact(rule.model);
	if (providerExact && modelExact) {
		return 3;
	}
	if (modelExact) {
		return 2;
	}
	if (providerExact) {
		return 1;
	}
	return 0;
}

export function matchRule(rule: MatchRule, model: ModelIdentity): boolean {
	return (
		fieldMatches(rule.provider, model.provider) &&
		fieldMatches(rule.model, model.id)
	);
}

/** Returns the best (most specific) matching rule of a binding, or undefined. */
export function matchBinding(
	binding: Binding,
	model: ModelIdentity,
	scope: Scope,
): BindingMatch | undefined {
	let best: BindingMatch | undefined;
	for (const rule of binding.match) {
		if (!matchRule(rule, model)) {
			continue;
		}
		const specificity = ruleSpecificity(rule);
		if (!best || specificity > best.specificity) {
			best = { binding, scope, rule, specificity };
		}
	}
	return best;
}
