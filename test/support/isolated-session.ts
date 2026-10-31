import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	type CompactionSettings,
	type CreateModelRuntimeOptions,
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	type PromptTemplate,
	type RetrySettings,
	type SessionManager,
	type SessionStartEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Placeholder credential. It is never sent anywhere: the transport only accepts the synthetic route. */
export const PLACEHOLDER_API_KEY = "pi-harness-placeholder-key";
export const SYNTHETIC_PROVIDER_ID = "anthropic";
export const SYNTHETIC_MODEL_ID = "claude-sonnet-4-5";
export const SYNTHETIC_OPENAI_MODEL_ID = "gpt-5";
export const SYNTHETIC_GOOGLE_MODEL_ID = "gemini-2.5-flash";

type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;

export interface Sandbox {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly sessionDir: string;
	dispose(): Promise<void>;
}

/**
 * Temporary roots, agent directory, project directory, and session directory. Pi's default loader
 * also enumerates ancestors of the working directory, so the sandbox root must sit outside the real
 * home directory; redirecting HOME alone is not enough. The base is chosen by realpath, so a symlinked
 * parent cannot lead back into the home. Environment variables are restored on dispose.
 */
export async function createSandbox(): Promise<Sandbox> {
	const base = await selectSandboxBase(realpathSync(homedir()));
	const root = await mkdtemp(join(base.path, base.prefix));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const sessionDir = join(root, "sessions");
	try {
		for (const directory of [home, agentDir, cwd, sessionDir]) {
			await mkdir(directory);
		}
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}

	const previous = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_OFFLINE: process.env.PI_OFFLINE,
	};
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";

	return {
		root,
		home,
		agentDir,
		cwd,
		sessionDir,
		async dispose() {
			for (const [name, value] of Object.entries(previous)) {
				restoreEnv(name, value);
			}
			// Windows can still hold a directory Pi had open a moment ago; retrying
			// keeps that from failing an unrelated test.
			await rm(root, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 100,
			});
		},
	};
}

interface SandboxBase {
	readonly path: string;
	readonly prefix: string;
}

/**
 * First candidate whose real path is outside the real home. The package root is the fallback,
 * independent of the caller's working directory, so its temporary roots match the ignore rule.
 * Throws before any Pi call when neither candidate is safe.
 */
async function selectSandboxBase(realHome: string): Promise<SandboxBase> {
	const candidates: SandboxBase[] = [
		{ path: tmpdir(), prefix: "push-prompts-harness-" },
		{ path: fileURLToPath(new URL("../../", import.meta.url)), prefix: ".harness-tmp-" },
	];
	for (const candidate of candidates) {
		const realPath = realpathSync(candidate.path);
		if (!isInsideDirectory(realPath, realHome)) {
			return { path: realPath, prefix: candidate.prefix };
		}
	}
	throw new Error("No sandbox base outside the real home directory; refusing to run discovery-sensitive harness");
}

/** Lexical containment of real paths; no directory listing. */
export function isInsideDirectory(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

/** In-memory credential store with one placeholder API key for the synthetic provider. */
class MemoryCredentialStore implements CredentialStore {
	private readonly credentials = new Map<string, Awaited<ReturnType<CredentialStore["read"]>>>();

	constructor(providerIds: readonly string[], key?: string) {
		if (key === undefined) {
			return;
		}
		for (const providerId of providerIds) {
			this.credentials.set(providerId, { type: "api_key", key });
		}
	}

	async read(providerId: string) {
		return this.credentials.get(providerId);
	}

	async list() {
		return [...this.credentials].map(([providerId, credential]) => ({
			providerId,
			type: credential?.type ?? "api_key",
		}));
	}

	async modify(providerId: string, fn: Parameters<CredentialStore["modify"]>[1]) {
		const next = await fn(this.credentials.get(providerId));
		if (next) {
			this.credentials.set(providerId, next);
		}
		return this.credentials.get(providerId);
	}

	async delete(providerId: string) {
		this.credentials.delete(providerId);
	}
}

/**
 * Model runtime without a models file, catalog refresh, or a credential file. The placeholder key is
 * stored for the requested providers so every built-in adapter reaches the synthetic transport instead
 * of failing on missing auth. ModelRuntime exposes no public disposal and holds only memory in this
 * configuration, so nothing needs releasing.
 */
export async function createSyntheticRuntime(
	options: { readonly withApiKey?: boolean; readonly providers?: readonly string[] } = {},
): Promise<ModelRuntime> {
	const providers = options.providers ?? [SYNTHETIC_PROVIDER_ID];
	return ModelRuntime.create({
		credentials: new MemoryCredentialStore(
			providers,
			options.withApiKey === false ? undefined : PLACEHOLDER_API_KEY,
		),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

export interface HarnessSessionOptions {
	readonly sandbox: Sandbox;
	readonly runtime: ModelRuntime;
	readonly sessionManager: SessionManager;
	readonly extensionFactories?: InlineExtension[];
	/** Prompt templates supplied through the public `promptsOverride`; discovery stays disabled. */
	readonly promptTemplates?: PromptTemplate[];
	/** Selected built-in model; defaults to the synthetic Anthropic model. */
	readonly model?: { readonly providerId: string; readonly modelId: string };
	/** Explicit built-in tool allowlist; omitted keeps every tool disabled. */
	readonly tools?: readonly string[];
	/** Overrides the in-memory settings while keeping retry and compaction off by default. */
	readonly settings?: { readonly compaction?: CompactionSettings; readonly retry?: RetrySettings };
	/** Project trust as the host reports it to extensions; the SDK default is trusted. */
	readonly projectTrusted?: boolean;
	/** Thinking level of the session; omitted keeps the harness default of off. */
	readonly thinkingLevel?: AgentSession["thinkingLevel"];
	/** Why Pi reports the session as started; the SDK default is "startup". */
	readonly sessionStartReason?: SessionStartEvent["reason"];
}

export interface HarnessSession {
	readonly session: AgentSession;
	readonly resourceLoader: DefaultResourceLoader;
}

/**
 * Session through the public SDK with ambient discovery disabled: no file-based extensions, skills,
 * prompt templates, themes, or context files. Only the inline extensions passed here load.
 */
export async function createHarnessSession(options: HarnessSessionOptions): Promise<HarnessSession> {
	const { sandbox, runtime, sessionManager } = options;
	const settingsManager = SettingsManager.inMemory(
		{
			compaction: { enabled: false, ...options.settings?.compaction },
			retry: { enabled: false, ...options.settings?.retry },
		},
		options.projectTrusted === undefined
			? {}
			: { projectTrusted: options.projectTrusted },
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd: sandbox.cwd,
		agentDir: sandbox.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: options.extensionFactories ?? [],
		promptsOverride: options.promptTemplates && (() => ({ prompts: options.promptTemplates ?? [], diagnostics: [] })),
	});
	await resourceLoader.reload();

	const providerId = options.model?.providerId ?? SYNTHETIC_PROVIDER_ID;
	const modelId = options.model?.modelId ?? SYNTHETIC_MODEL_ID;
	const model = runtime.getModel(providerId, modelId);
	if (!model) {
		throw new Error(`Built-in model ${providerId}/${modelId} is not available`);
	}

	const { session } = await createAgentSession({
		cwd: sandbox.cwd,
		agentDir: sandbox.agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: options.thinkingLevel ?? "off",
		...(options.tools ? { tools: [...options.tools] } : { noTools: "all" as const }),
		resourceLoader,
		sessionManager,
		settingsManager,
		...(options.sessionStartReason
			? {
					sessionStartEvent: {
						type: "session_start" as const,
						reason: options.sessionStartReason,
					},
				}
			: {}),
	});
	return { session, resourceLoader };
}
