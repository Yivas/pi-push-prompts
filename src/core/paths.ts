/**
 * Derived from pi-prompt-profiles src/core/paths.ts at 3f6d583 (MIT).
 *
 * Paths and filesystem helpers. Every path that comes from a scope root is
 * checked against the real filesystem before it is read, so a symlink cannot
 * pull text from outside the authorized root.
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG_DIR_NAME = ".pi";
export const ROOT_DIR_NAME = "push-prompts";

export function globalRoot(agentDir: string): string {
	return path.join(agentDir, ROOT_DIR_NAME);
}

export function projectRoot(cwd: string, configDirName: string): string {
	return path.join(cwd, configDirName, ROOT_DIR_NAME);
}

export function profilesDir(root: string): string {
	return path.join(root, "profiles");
}

export function configPath(root: string): string {
	return path.join(root, "config.json");
}

/** Rewrites a path through the filesystem so symlinks cannot fake containment. */
export function resolveRealPath(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		return path.resolve(target);
	}
}

export function isInside(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

/**
 * Checks containment against the real filesystem. A symlinked profile that
 * points outside its authorized root is rejected, not silently followed.
 */
export function isRealPathInside(root: string, target: string): boolean {
	return isInside(resolveRealPath(root), resolveRealPath(target));
}

export function readTextIfExists(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw cause;
	}
}

/**
 * Writes atomically: a sibling temp file is renamed over the target so a crash
 * or a concurrent reader never observes a half-written file.
 */
export function atomicWriteFile(filePath: string, content: string): void {
	const directory = path.dirname(filePath);
	fs.mkdirSync(directory, { recursive: true });
	const temporary = path.join(
		directory,
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
		fs.renameSync(temporary, filePath);
	} catch (cause) {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// The temp file may not exist if the write itself failed.
		}
		throw cause;
	}
}

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
