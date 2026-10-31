/**
 * Derived from pi-prompt-profiles src/core/store.ts and src/adapter/config-edit.ts
 * at 3f6d583 (MIT).
 *
 * Reads both roots into one state object and writes `config.json` safely. An
 * untrusted project contributes nothing: no config and no profiles. Writes
 * compare the content that was read, not a timestamp, so a concurrent edit is
 * reported instead of being overwritten; the replacement itself is atomic.
 */

import { loadConfigFile } from "./config.ts";
import {
	atomicWriteFile,
	configPath,
	globalRoot,
	projectRoot,
	readTextIfExists,
	stripBom,
} from "./paths.ts";
import { loadProfiles } from "./profiles.ts";
import type { Diagnostic, ProfileCatalog, SourceConfig } from "./types.ts";

export interface LoadedState {
	cwd: string;
	agentDir: string;
	configDirName: string;
	projectTrusted: boolean;
	globalConfig: SourceConfig;
	projectConfig: SourceConfig;
	globalProfiles: ProfileCatalog;
	projectProfiles: ProfileCatalog;
	diagnostics: Diagnostic[];
}

export function emptyProjectConfig(
	cwd: string,
	configDirName: string,
): SourceConfig {
	return {
		scope: "project",
		path: configPath(projectRoot(cwd, configDirName)),
		exists: false,
		config: undefined,
		diagnostics: [],
	};
}

function emptyProjectProfiles(): ProfileCatalog {
	return { scope: "project", profiles: new Map(), createDiagnostics: [] };
}

export interface LoadStateOptions {
	cwd: string;
	agentDir: string;
	configDirName: string;
	projectTrusted: boolean;
}

/**
 * Reads global state always, and project state only when the project is
 * trusted. Nothing from an untrusted project reaches the catalogs.
 */
export function loadState(options: LoadStateOptions): LoadedState {
	const { cwd, agentDir, configDirName, projectTrusted } = options;

	const globalConfig = loadConfigFile(
		configPath(globalRoot(agentDir)),
		"global",
	);
	const globalProfiles = loadProfiles(
		globalRoot(agentDir),
		"global",
		globalConfig.config?.profiles,
	);

	let projectConfig = emptyProjectConfig(cwd, configDirName);
	let projectProfiles = emptyProjectProfiles();
	if (projectTrusted) {
		projectConfig = loadConfigFile(
			configPath(projectRoot(cwd, configDirName)),
			"project",
		);
		projectProfiles = loadProfiles(
			projectRoot(cwd, configDirName),
			"project",
			projectConfig.config?.profiles,
		);
	}

	const diagnostics: Diagnostic[] = [
		...globalConfig.diagnostics,
		...globalProfiles.createDiagnostics,
		...projectConfig.diagnostics,
		...projectProfiles.createDiagnostics,
	];

	return {
		cwd,
		agentDir,
		configDirName,
		projectTrusted,
		globalConfig,
		projectConfig,
		globalProfiles,
		projectProfiles,
		diagnostics,
	};
}

export type RawConfig = Record<string, unknown>;

export interface ConfigSnapshot {
	/** Parsed file as read; unknown keys are still there to be written back. */
	config: RawConfig;
	exists: boolean;
	/** Exact text read, or undefined when the file did not exist. */
	text: string | undefined;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function readRawConfig(filePath: string): ConfigSnapshot {
	const text = readTextIfExists(filePath);
	if (text === undefined) {
		return { config: { version: 1 }, exists: false, text: undefined };
	}
	const parsed: unknown = (() => {
		try {
			return JSON.parse(stripBom(text));
		} catch (cause) {
			throw new Error(`${filePath}: invalid JSON (${messageOf(cause)}).`);
		}
	})();
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${filePath}: the root must be a JSON object`);
	}
	return { config: parsed as RawConfig, exists: true, text };
}

/**
 * Writes only when the file still holds what was read, so a concurrent edit is
 * reported instead of being lost. The whole object is rewritten, which is what
 * preserves unknown fields.
 */
export function writeRawConfigIfUnchanged(
	filePath: string,
	snapshot: ConfigSnapshot,
	next: RawConfig,
): void {
	const current = readTextIfExists(filePath);
	if (snapshot.text === undefined) {
		if (current !== undefined) {
			throw new Error(
				`${filePath} appeared on disk since it was read; reload and try again.`,
			);
		}
	} else if (current !== snapshot.text) {
		throw new Error(
			`${filePath} changed on disk since it was read; reload and try again.`,
		);
	}
	atomicWriteFile(filePath, `${JSON.stringify(next, null, "\t")}\n`);
}
