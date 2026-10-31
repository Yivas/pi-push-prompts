/**
 * pi-push-prompts: prepends and appends profile text to each new user message.
 *
 * The cache contract decides the design. Only the user message Pi is
 * finalizing is touched, in place, before it is persisted and sent; every
 * message already in the session keeps its exact content, role, order and
 * representation, and nothing here changes the system prompt, tools, model,
 * thinking level, cache policy or provider payload.
 *
 * Where the work happens:
 * - `input` only checks that the profile the user expects can be built. It
 *   never transforms text: Pi would run it before expanding `/skill:` and
 *   prompt templates.
 * - `message_end` sees the finalized user message, resolves from already
 *   loaded state and inserts the text, records what it inserted in a custom
 *   entry and returns the replacement. It is the only place a message is
 *   decorated and the only place `once` is consumed. It reads from disk only
 *   when the working directory or the project's trust changed since the last
 *   load, which `Runtime.ensure` has to redo before it can answer.
 * - `session_start` and `session_tree` reload config, profiles and the branch
 *   state; a fork or a tree navigation disarms `once`.
 * - Presentation (the optional Push row and the native row's original text)
 *   reads the session and the config while painting and never writes.
 */

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	APPLIED_ENTRY_TYPE,
	buildAppliedEntry,
} from "./core/applied.ts";
import {
	createAppliedEntryRenderer,
	createNativeRowTransformer,
	toUserContent,
} from "./adapter/render.ts";
import { registerPushCommands } from "./adapter/commands.ts";
import { Runtime, messageOf } from "./adapter/runtime.ts";
import { en } from "./i18n/en.ts";

export type { PushStatus, PushWhy, Runtime } from "./adapter/runtime.ts";
export type { AppliedView } from "./adapter/render.ts";

/**
 * Builds the adapter for one Pi extension load and returns the runtime the
 * `/push` commands will drive. Kept separate from the exported factory so a
 * test can hold the runtime without reaching into Pi.
 */
export function createPushPromptsExtension(pi: ExtensionAPI): Runtime {
	const runtime = new Runtime(pi, getAgentDir(), CONFIG_DIR_NAME);
	// Objects this extension already decorated. Pi copies a replacement onto the
	// finalized message in place, so a second emission for the same object would
	// otherwise add the text twice.
	const decorated = new WeakSet<object>();
	const nativeRow = createNativeRowTransformer(() =>
		runtime.activeBranchEntries(),
	);

	function reportErrors(ctx: ExtensionContext): void {
		const errors = runtime.errorDiagnostics();
		if (errors.length === 0) {
			return;
		}
		ctx.ui.notify(
			en.extension.configErrors(
				errors.map((entry) => entry.message).join("\n"),
			),
			"error",
		);
	}

	pi.on("session_start", (event, ctx) => {
		try {
			runtime.attach(ctx);
			runtime.reload();
			// A fork is a new branch built from an older point: whatever `once`
			// the source point held must not fire here.
			if (event.reason === "fork") {
				runtime.clearOnce();
			}
			reportErrors(ctx);
		} catch (cause) {
			ctx.ui.notify(en.extension.failed(messageOf(cause)), "error");
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		try {
			runtime.attach(ctx);
			runtime.reload();
			runtime.clearOnce();
		} catch (cause) {
			ctx.ui.notify(en.extension.failed(messageOf(cause)), "error");
		}
	});

	pi.on("model_select", (_event, ctx) => {
		try {
			runtime.attach(ctx);
			runtime.reload();
		} catch {
			// A status refresh must never break model selection.
		}
	});

	pi.on("input", (event, ctx) => {
		runtime.attach(ctx);
		// The text goes back to the editor, so a stopped send never loses it.
		const stop = (message: string): { action: "handled" } => {
			ctx.ui.notify(message, "error");
			if (ctx.hasUI) {
				ctx.ui.setEditorText(event.text);
			}
			return { action: "handled" };
		};
		try {
			runtime.ensure(ctx);
			const blocker = runtime.precheck();
			if (!blocker) {
				return { action: "continue" as const };
			}
			const hint = ctx.hasUI
				? en.extension.blockedRestore
				: en.extension.blockedKeep;
			return stop(
				`${en.extension.prefix}: ${en.extension.blockedBy(blocker.code, blocker.message)} ${hint}`,
			);
		} catch (cause) {
			// The check itself failed, so Push cannot tell what would have applied.
			// An explicit `off` cannot add anything and the send goes through;
			// every other mode stops rather than send something unchecked.
			const reason = `${en.extension.prefix}: ${en.extension.checkFailed(messageOf(cause))}`;
			if (!runtime.mayApplyProfile()) {
				ctx.ui.notify(`${reason} ${en.extension.sentUnchanged}`, "error");
				return { action: "continue" as const };
			}
			return stop(reason);
		}
	});

	pi.on("message_end", (event, ctx) => {
		runtime.attach(ctx);
		const message = event.message;
		// Only finalized user messages. Custom messages, tool results, compaction
		// and branch summaries and bash executions carry a different role.
		if (message.role !== "user" || decorated.has(message)) {
			return undefined;
		}
		try {
			runtime.ensure(ctx);
			const content = toUserContent(message.content);
			const plan = runtime.plan(content);
			if (!plan) {
				return undefined;
			}
			const entry = buildAppliedEntry({
				ref: plan.ref,
				mode: plan.mode,
				decoration: plan.decoration,
				timestamp: message.timestamp,
				provider: plan.provider,
				model: plan.model,
				originalContent: content,
			});
			decorated.add(message);
			pi.appendEntry(APPLIED_ENTRY_TYPE, entry);
			const replacement = {
				...message,
				content: plan.decoration.content as typeof message.content,
			} as typeof message;
			if (plan.mode === "once") {
				runtime.clearOnce();
			}
			return { message: replacement };
		} catch (cause) {
			ctx.ui.notify(en.extension.decorateFailed(messageOf(cause)), "error");
			return undefined;
		}
	});

	pi.registerEntryRenderer(
		APPLIED_ENTRY_TYPE,
		createAppliedEntryRenderer(() => runtime.display()),
	);

	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "user" ? nativeRow(markdown) : markdown,
	);

	registerPushCommands(pi, runtime);

	return runtime;
}

const pushPromptsExtension: ExtensionFactory = (pi) => {
	createPushPromptsExtension(pi);
};

export default pushPromptsExtension;
