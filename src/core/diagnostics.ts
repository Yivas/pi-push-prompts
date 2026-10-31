/**
 * Derived from pi-prompt-profiles src/core/diagnostics.ts at 3f6d583 (MIT).
 */

import type { Diagnostic, DiagnosticLevel } from "./types.ts";

export function diag(
	level: DiagnosticLevel,
	code: string,
	message: string,
): Diagnostic {
	return { level, code, message };
}

export function error(code: string, message: string): Diagnostic {
	return diag("error", code, message);
}

export function warn(code: string, message: string): Diagnostic {
	return diag("warn", code, message);
}

export function info(code: string, message: string): Diagnostic {
	return diag("info", code, message);
}

/** The first diagnostic that prevented normal operation, for short messages. */
export function firstError(diagnostics: Diagnostic[]): Diagnostic | undefined {
	return diagnostics.find((entry) => entry.level === "error");
}
