/**
 * The sibling `pi-prompt-profiles` extension (`/sp`), which edits the system
 * prompt, as an inline extension factory for the harness. It is loaded from its
 * own checkout: nothing there is built, installed, edited or added as a
 * dependency, and no part of it is reimplemented or stubbed here.
 *
 * Two sources are available because that checkout has moved past the revision
 * the coexistence work was written against:
 * - `working-tree` reads `src/index.ts` where it stands (0.11.0 at the time of
 *   writing).
 * - `3f6d583` reads the sources of that release (0.10.0) out of Git, because the
 *   checkout must not be switched to it.
 * On the pinned Pi 1.4.0 the checkout also registers the structured
 * `context_with_system` hook, while `3f6d583` registers `before_agent_start`
 * only, so the second source measures that version drift and not a second
 * behaviour.
 *
 * Two things are needed to load those sources the way Pi does:
 * - jiti, the loader Pi ships for file extensions, resolves the `.js` specifiers
 *   in them to the `.ts` files beside them. Node's own type stripping does not,
 *   so the same loader is used here.
 * - Both Pi packages are aliased to the copies this repository pins, never to an
 *   ambient install. A real install has one copy, and the extension reads
 *   `VERSION`, `CONFIG_DIR_NAME` and `getAgentDir` from it.
 *
 * `PI_PACKAGE_DIR` is dropped before anything imports Pi, by
 * `pinned-pi-package.ts` imported below. Pi takes `VERSION` from the package.json
 * that variable points at, and `VERSION` decides which system prompt hook the
 * extension registers: `VERSION >= 1.4` uses the structured
 * `context_with_system` hook. A shell started by an agent can carry the variable
 * for another install, so importing this module first — before any other module
 * that imports `@earendil-works/pi-coding-agent` — is what keeps the run on the
 * pinned Pi. `loadPromptProfilesExtension` checks that and fails loudly
 * otherwise, which is also what a `biome assist/source/organizeImports` run would
 * produce if it moved the package imports above this one.
 */

import "./pinned-pi-package.ts";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import type { Sandbox } from "./isolated-session.ts";

/** Names the checkout the coexistence suite loads. */
const CHECKOUT_ENV = "PI_PROMPT_PROFILES_CHECKOUT";
/** The release the coexistence work started from, read out of Git. */
const PINNED_REVISION = "3f6d583";
/** Directory the sibling extension keeps its config and profiles in, per scope. */
const CONFIG_ROOT = "system-prompts";
const CONFIG_DIR_NAME = ".pi";

export type PromptProfilesSource = "working-tree" | "3f6d583";

type PromptProfilesFactory = (pi: ExtensionAPI) => void;

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piAiEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));

/** Version of the Pi package this repository installed, read from its manifest. */
async function pinnedPiVersion(): Promise<string> {
	const manifest = JSON.parse(
		await readFile(join(dirname(dirname(piEntry)), "package.json"), "utf8"),
	) as { version?: unknown };
	if (typeof manifest.version !== "string") {
		throw new Error(`${piEntry} has no version in its package.json`);
	}
	return manifest.version;
}

const sources = new Map<PromptProfilesSource, Promise<string>>();

/**
 * The sibling checkout, or `undefined` when `PI_PROMPT_PROFILES_CHECKOUT` is
 * unset. There is no default path: the sibling extension lives in its own
 * repository, so a guessed location would either not exist or silently measure a
 * revision nobody chose. `coexistence.test.ts` reads this to skip itself.
 */
export function promptProfilesCheckout(): string | undefined {
	const checkout = process.env[CHECKOUT_ENV];
	return checkout === undefined || checkout.length === 0 ? undefined : checkout;
}

/**
 * Why the coexistence suite cannot run here, or `false` when it can.
 *
 * A checkout without the pinned revision cannot answer for the 0.10.0 side that
 * the suite reads out of Git, and a shallow clone is the usual reason. Probing
 * it here turns that into one skip instead of a failure inside Git.
 */
export function promptProfilesSkipReason(): string | false {
	const checkout = promptProfilesCheckout();
	if (checkout === undefined) {
		return `${CHECKOUT_ENV} is not set: no pi-prompt-profiles checkout to compare against`;
	}
	try {
		execFileSync(
			"git",
			["-C", checkout, "cat-file", "-e", `${PINNED_REVISION}^{commit}`],
			{ stdio: "ignore" },
		);
	} catch {
		return `${CHECKOUT_ENV} does not carry ${PINNED_REVISION}: the full history of that checkout is needed and a shallow clone has none`;
	}
	return false;
}

/** The configured checkout, for the paths that cannot work without one. */
function requireCheckout(): string {
	const checkout = promptProfilesCheckout();
	if (checkout === undefined) {
		throw new Error(
			`Set ${CHECKOUT_ENV} to a pi-prompt-profiles checkout to load the sibling extension.`,
		);
	}
	return checkout;
}

/**
 * Resolves the directory a source is loaded from. The Git revision is written to
 * a temporary directory once per run; `removePromptProfilesSources` disposes it.
 */
function sourceDirectory(source: PromptProfilesSource): Promise<string> {
	const cached = sources.get(source);
	if (cached) {
		return cached;
	}
	const pending =
		source === "working-tree"
			? Promise.resolve(requireCheckout())
			: extractRevision(PINNED_REVISION);
	sources.set(source, pending);
	return pending;
}

async function extractRevision(revision: string): Promise<string> {
	const directory = await mkdtemp(
		join(tmpdir(), `pi-prompt-profiles-${revision}-`),
	);
	const git = (args: readonly string[]): string =>
		execFileSync("git", ["-C", requireCheckout(), ...args], { encoding: "utf8" });
	const files = git(["ls-tree", "-r", "--name-only", revision, "src"])
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	for (const file of files) {
		const target = join(directory, file);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, git(["show", `${revision}:${file}`]), "utf8");
	}
	return directory;
}

/** Removes the temporary checkouts this module wrote. */
export async function removePromptProfilesSources(): Promise<void> {
	for (const [source, directory] of sources) {
		sources.delete(source);
		if (source !== "working-tree") {
			await rm(await directory, { recursive: true, force: true });
		}
	}
}

/**
 * The extension factory for one source, ready to be passed to Pi as an inline
 * extension. The module is loaded once; every session that loads the extension
 * calls the factory again, which is what a Pi process does with a file
 * extension.
 */
export async function loadPromptProfilesExtension(
	source: PromptProfilesSource,
): Promise<InlineExtension> {
	const loadedVersion = (
		await import(pathToFileURL(piEntry).href)
	).VERSION as string;
	const pinned = await pinnedPiVersion();
	if (loadedVersion !== pinned) {
		throw new Error(
			`Pi reported VERSION ${loadedVersion}, but this repository pins ${pinned}. ` +
				"PI_PACKAGE_DIR was set before @earendil-works/pi-coding-agent was imported: " +
				"import test/support/prompt-profiles-harness.ts before anything else that imports Pi.",
		);
	}
	const factory = await loadFactory(await sourceDirectory(source));
	return (pi: ExtensionAPI) => {
		factory(pi);
	};
}

const factories = new Map<string, Promise<PromptProfilesFactory>>();

async function loadFactory(directory: string): Promise<PromptProfilesFactory> {
	const cached = factories.get(directory);
	if (cached) {
		return cached;
	}
	const pending = (async () => {
		const jiti = createJiti(import.meta.url, {
			fsCache: false,
			moduleCache: false,
			alias: {
				"@earendil-works/pi-coding-agent": piEntry,
				"@earendil-works/pi-ai": piAiEntry,
			},
		});
		const module = (await jiti.import(
			join(directory, "src", "index.ts"),
		)) as { default?: unknown };
		if (typeof module.default !== "function") {
			throw new Error(`${directory} does not export an extension factory`);
		}
		return module.default as PromptProfilesFactory;
	})();
	factories.set(directory, pending);
	return pending;
}

/** Directory the sibling extension reads for one scope. */
export function promptProfilesRoot(
	sandbox: Sandbox,
	scope: "global" | "project",
): string {
	return scope === "global"
		? join(sandbox.agentDir, CONFIG_ROOT)
		: join(sandbox.cwd, CONFIG_DIR_NAME, CONFIG_ROOT);
}

/** Writes one profile file, whose file name is its id. */
export async function writePromptProfilesProfile(
	sandbox: Sandbox,
	scope: "global" | "project",
	id: string,
	text: string,
): Promise<void> {
	const directory = join(promptProfilesRoot(sandbox, scope), "profiles");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, `${id}.md`), text, "utf8");
}

/** Writes the config file of one scope. */
export async function writePromptProfilesConfig(
	sandbox: Sandbox,
	scope: "global" | "project",
	config: Record<string, unknown>,
): Promise<void> {
	const directory = promptProfilesRoot(sandbox, scope);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "config.json"),
		`${JSON.stringify({ version: 1, ...config }, null, 2)}\n`,
		"utf8",
	);
}
