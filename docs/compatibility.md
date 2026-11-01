# Compatibility

What the test runs behind [the README](../README.md) actually exercised, and what they did not.

## Baseline

| Component | Version | Source |
| --- | --- | --- |
| Pi | 1.4.0 | `devDependencies` in `package.json`, pinned exactly; `peerDependencies` declares `*` because Pi supplies that package at runtime |
| Node.js | `>=22.19.0` | `engines` in `package.json`; the suite runs TypeScript directly through `node --test` |
| TypeScript | 5.9.3 | `devDependencies` |
| Biome | 2.5.15 | `devDependencies`, lint step of `npm run check` |

The suite holds 285 tests when `PI_PROMPT_PROFILES_CHECKOUT` points at the reference checkout. Without it, the coexistence cases register one skip instead of running, yielding 271 registered tests by count; that is not a recorded run of 0.3.0 without coexistence.

Before the final wrapping-performance correction, `npm run check` passed 285/285 tests with coexistence and no skips. After that correction, lint and typecheck passed, the affected extension integration file passed 22/22 tests, the final provider cache matrix passed 24/24, and an independent review reran all six presentation tests successfully. The full suite was not repeated after that last correction or the version-and-documentation update. These runs used Node.js 24.22.1 and Pi 1.4.0.

The workflow in `.github/workflows/ci.yml` repeats `npm ci --ignore-scripts` and `npm run check` on Node.js 22.19.0 and 24 on every push to `main` and every pull request; Node.js 22 was not part of the local runs recorded here.

Pi 1.1.0 was the earlier baseline. This page describes the 1.4.0 runs only: the 1.1.0 run was replaced rather than kept, so anything here that the extension promises is evidence for 1.4.0 alone.

## Providers tested

Three adapters, all of them Pi's own, with Pi 1.4.0's built-in provider code. `globalThis.fetch` is replaced for the duration of a test, so the adapter serializes the body exactly as it would in a real run and the test captures it at the process boundary. Every other URL and method fails the test instead of reaching the network.

| Adapter | Synthetic model | Route the adapter uses |
| --- | --- | --- |
| Anthropic Messages | `anthropic/claude-sonnet-4-5` | `https://api.anthropic.com/v1/messages?beta=true` |
| OpenAI Responses | `openai/gpt-5` | `https://api.openai.com/v1/responses` |
| Google Generative AI | `google/gemini-2.5-flash` | `https://generativelanguage.googleapis.com/v1beta/models/<model>:streamGenerateContent?alt=sse` |

No other provider or model was exercised. The synthetic replies are minimal success streams shaped like each adapter expects; they are not recordings of real provider traffic.

## Covered by the runs

- **Cache contract, per provider**, against a plugin-free baseline over the same saved session: `test/integration/cache-prefix.test.ts`. Covers no profile, `off`, prepend, append, both, inherited text, editing a profile between sends, `display` changes, `once` armed and cancelled, selection changes, read-only commands, a model switch to another provider's binding, and reopening with and without the extension.
- **Coexistence with a system prompt extension**: `test/integration/coexistence.test.ts`. `pi-prompt-profiles` is loaded from its own checkout, both at 0.11.0 and at 0.10.0 read out of Git, on all three adapters and in both load orders. On 1.4.0 the 0.11.0 checkout edits the request through `context_with_system`; the request with both extensions differs from the request with `pi-prompt-profiles` alone only in the text Push inserted into the new user message. The checkout is named by `PI_PROMPT_PROFILES_CHECKOUT`; without it, or with a checkout that does not carry the `3f6d583` revision (a shallow clone has no 0.10.0 side to read), these cases report one skip with the reason and nothing else is measured in their place. The workflow checks out `Yivas/pi-prompt-profiles` at `084f7f8b56bcaefc1236e8a2c55d0ae118403b2d` with full history, so the 0.10.0 side can be read from Git there too.
- **Decoration lifecycle**: automatic retry after a provider error, overflow recovery, continuation after a tool call, reload with a queued follow-up, `pi.sendUserMessage` while idle and with `steer`/`followUp`, aborting a run with a queued message, clearing a queued message, manual compaction, a second extension replacing the same message in both load orders: `test/integration/host-contract.test.ts`, `test/integration/push-extension.test.ts`.
- **Message shape** (unit tests, `test/core/decorate.test.ts`): string wrapping, a single side without a stray separator, inheritance order, BOM and CRLF normalization with one trailing newline dropped, user text never trimmed, merging into the first and last text blocks, a new text block before or after an image, and no mutation of the input.
- **Profile loading** (unit tests, `test/core/profiles.test.ts`, `test/core/inherit.test.ts`): both text files, one file only, descriptions, and the skips for empty text, unsafe directory names, oversized files and paths that resolve outside the root; ordering, a project profile inheriting a global base, cycles, a missing parent, and the depth and total-size limits.
- **Session state**: `once` consumed on the finalized message, kept when a queued message is dropped or the pre-check stops the send, dropped on tree navigation and on fork, and not resurrected by moving forward over its entry: `test/integration/push-extension.test.ts`.
- **Resolution**: model change, the three subagent policies, untrusted versus trusted projects, and compaction with the extension loaded: `test/integration/push-policies.test.ts`, `test/integration/push-extension.test.ts`.
- **Commands**: rejected sends, session changes, reports, config and profile writes, settings, flags: `test/integration/commands.test.ts`. Dialogs answer through a scripted UI; the state, files and notices are what the assertions check.
- **Presentation functions**: the registered entry renderer in both `display` modes, and the markdown transformer for a live session, after reopen, and for an ambiguous text: `test/integration/push-extension.test.ts`, `test/integration/cache-prefix.test.ts`. The registered added-text renderer is also rendered with Pi's built-in dark theme at 40, 80 and 120 columns, live and reopened, with long sentences, multiline text, unbroken words, a 60 KB Unicode line, wide and combining Unicode characters, literal Markdown and profile whitespace. Tests check complete text and width containment, terminal-control neutralization, hidden mode and no session mutation. Widths 0–6 also check termination and containment; widths below two draw nothing because a wide grapheme cannot fit.
- **Isolation**: the sandbox must live outside the real home directory, environment variables are restored, no personal configuration or skills are loaded, `PI_PACKAGE_DIR` is cleared so Pi resolves this repository's install, and unexpected outbound routes fail the test: `test/integration/push-runner.test.ts`, `test/support/isolated-session.ts`.

## Not run

- **Terminal painting.** No run draws the transcript or a screen inside Pi. The searchable picker is covered in two ways: an independent review probe rendered the real `SearchList` with a synthetic theme at 40, 50, 80 and 120 columns and Pi rejected no line for width, and `test/integration/picker-list.test.ts` drives its key handling on the component itself (Enter on a filter that matches nothing, Backspace, Enter on a match, Esc). Nothing was painted in a real terminal, so colours, contrast, resize behaviour and the full Pi screen remain unverified. The added-row component renders described above do not remove those limits.
- **Block content end to end.** The integration runs send text messages. The block shaping that merges into an existing text block or adds one around an image is covered only by the unit tests.
- **Real provider calls.** No request leaves the machine. Provider latency, real cache accounting, cache hit counters and provider-side retention were not observed.
- **A real subagent child process.** `pi-subagents` was not run; a test sets `PI_SUBAGENT_CHILD=1`, which is the whole signal the extension reads.
- **Other platforms.** The runs were on Windows. Linux and macOS were not run locally; the workflow also runs the suite on Ubuntu for every push, and those results are separate from the runs recorded here.
- **Symlink cases where links cannot be created.** The unit and integration tests that prove a symlink cannot read or write outside the root create real links and skip themselves when the host refuses. Nothing skipped in the Windows runs recorded here; on a host that refuses links those cases stay unverified.
- **Node.js 22 in a local run.** Allowed by `engines`, exercised by the workflow, never part of the local runs recorded here.
- **Installation of 0.3.0 as a Pi package.** `pi install npm:pi-push-prompts@0.3.0` was not executed during preparation, so the installed package path is not covered by these runs. The workflow does not install the package either; it clones the repository.
- **Other Pi versions.** No version other than 1.4.0 was run.
- **Editors and dialogs in a real terminal.** `ctx.ui.input`, `ctx.ui.editor`, `ctx.ui.select` and `ctx.ui.custom` are answered or stubbed by the harness.

## Public APIs used

Only documented Pi extension APIs, from `@earendil-works/pi-coding-agent`:

- Extension definition and setup: `ExtensionFactory`, `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, `getAgentDir`, `CONFIG_DIR_NAME`.
- Events: `pi.on` for `input`, `message_end`, `session_start`, `session_tree` and `model_select`.
- Session entries: `pi.appendEntry` with the custom types `push-prompts.applied` and `push-prompts.state`.
- Rendering: `pi.registerEntryRenderer`, `pi.registerMarkdownTransformer`, `EntryRenderer`, plus `SessionEntry` for reading the active branch.
- Commands and flags: `pi.registerCommand`, `pi.registerFlag`, `pi.getFlag`.
- Session context: `ctx.cwd`, `ctx.model`, `ctx.modelRegistry.getAvailable()`, `ctx.isProjectTrusted()`, `ctx.hasUI`, `ctx.mode`, `ctx.sessionManager.getBranch()`.
- User interface: `ctx.ui.notify`, `ctx.ui.setEditorText`, `ctx.ui.input`, `ctx.ui.editor`, `ctx.ui.select`, `ctx.ui.custom`, with the public `KeybindingsManager` and `Theme` types. The added-row renderer uses the platform's `Intl.Segmenter` and the public `visibleWidth`, `wrapTextWithAnsi` and `stripTerminalSequences` utilities from `@earendil-works/pi-tui`; its tests initialize the built-in theme through public `initTheme`, without a watcher.

No Pi internals, no provider wrapper, and no private module import. The only environment variable read is `PI_SUBAGENT_CHILD`.
