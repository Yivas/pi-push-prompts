# pi-push-prompts

Adds text from a profile to each new user message in Pi — before it, after it, or both — inside that same message.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Yivas/pi-push-prompts/blob/main/LICENSE)

Version `0.1.1`. MIT licensed, tested against Pi `1.4.0`.

[Install](#install) · [First use](#first-use) · [Commands](#push) · [Compatibility](https://github.com/Yivas/pi-push-prompts/blob/main/docs/compatibility.md) · [Releases](https://github.com/Yivas/pi-push-prompts/releases) · [Contributing](https://github.com/Yivas/pi-push-prompts/blob/main/CONTRIBUTING.md)

Profiles are plain text files. A session selection, a provider/model binding or a default profile decides which one applies. The extension does not change the system prompt, the tools, the model, the thinking level or any cache setting, and it never rewrites a message that was already sent.

## Status

- `0.1.1` is the current release, distributed as the npm package [`pi-push-prompts`](https://www.npmjs.com/package/pi-push-prompts). `0.1.0` was the first public release.
- Tested against Pi `1.4.0` (`@earendil-works/pi-coding-agent` 1.4.0) with Pi's built-in provider adapters and a simulated outbound transport, so the runs make no network calls. [docs/compatibility.md](https://github.com/Yivas/pi-push-prompts/blob/main/docs/compatibility.md) lists what those runs cover and what they leave out.
- `0.1.x` is the only release line. Fixes go there; there is no older line to support.

## Requirements

- Pi `1.4.0`, the version this release was tested against. Other versions may work; these runs do not cover them.
- Node.js `22.19.0` or newer to build and test the extension from source. Pi runs the extension itself.

## Install

```bash
pi install npm:pi-push-prompts@0.1.1
```

Add `--local` (`-l`) to record the package in `.pi/settings.json` for one project instead of your personal settings; Pi reads that file after you grant the project trust.

To try it for a single run without changing your settings:

```bash
pi -e npm:pi-push-prompts@0.1.1
```

From a checkout, for development:

```bash
git clone https://github.com/Yivas/pi-push-prompts
cd pi-push-prompts
npm ci --ignore-scripts
pi --extension ./src/index.ts
```

`pi --extension <path>` is Pi's documented way to load a file extension during development; Pi runs TypeScript through jiti, so nothing has to be compiled. Installing or loading the package does not create, move or change a profile.

## First use

Inside Pi, create a profile and use it for the session:

```text
/push new review --prepend "List the real defects first, then the summary."
/push use review
```

The next message you send carries that text at the top, and so does every message after it. `/push preview` prints the exact text the next message would receive, `/push status` shows where the selected profile came from, and `/push off` stops adding text without touching the profile or the history.


## What the extension does

A new user message is decorated once, in Pi's `message_end` event for that message, before Pi persists it and builds the request. Everything else stays where it was:

- Messages already in the session keep the text, role, position and representation they were sent with. Editing a profile, changing the selection or turning Push off affects the next new message and nothing earlier.
- Every new user message Pi finalizes is eligible: a typed prompt, a queued steer or follow-up, a message another extension sends. Custom messages, tool results, bash executions and compaction or branch summaries are not.
- Retries, continuations after a tool call, compaction, reload and reopening the session do not decorate again.
- The `/push` commands only read state, write `config.json` and profile files, and store session entries of their own. They never add text to a message.
- The extension makes no network calls and starts no processes.

## Where the text lands

The insert goes inside the new message, not around the history.

- A text message becomes `prepend`, a blank line, your text, a blank line, `append`. An empty side and its separator are omitted.
- Content with blocks (an appended image, for example) keeps every block in place. The prepend joins the first block when it is text and adds a new text block in front when it is not; the append does the same at the end.
- Profile text is read literally except for a leading BOM, which is stripped, CRLF line endings, which become LF, and one trailing newline, which is removed. Your own text is never trimmed or normalized.

## Profile layout

| Scope | Root |
| --- | --- |
| Global | `<agentDir>/push-prompts/` |
| Project | `<cwd>/.pi/push-prompts/` |

`<agentDir>` is Pi's agent directory and `<cwd>` is the directory Pi runs in. Each root holds `config.json` and one directory per profile:

```
<root>/
  config.json
  profiles/
    review/
      prepend.md
      append.md
```

- A profile needs text in `prepend.md`, in `append.md`, or in both; a directory with neither is skipped and reported.
- A profile is also skipped, with a diagnostic, when its directory name is not a safe id, when either file is larger than 64 KiB, or when a path resolves outside the root through a symlink.
- Inheritance: `profiles.<id>.extends` in `config.json` names one parent, and a bare id in that field resolves inside the same scope. Text is joined parent first and the most specific profile last, with a blank line between layers. A chain is limited to 8 profiles and 256 KiB of text; a missing parent, a cycle or either limit discards the whole profile rather than dropping a layer.
- Ids match `[A-Za-z0-9][A-Za-z0-9._-]*`, up to 64 characters, and cannot contain `..`. A reference is `global:<id>`, `project:<id>` or a bare id; inside `config.json` a bare id means the global scope, and commands resolve a bare id against the project profiles first when the project is trusted. `/push default` is the exception: it reads a bare id in the global scope, so naming a project profile there needs `project:<id>` or `--scope project`.

An untrusted project contributes nothing: its `config.json` and its profiles are neither read nor written. Picking up a project configuration requires Pi's trust decision for that directory.

## `config.json`

The file is versioned and validated by [schema/config.schema.json](https://github.com/Yivas/pi-push-prompts/blob/main/schema/config.schema.json). `version` is required and must be `1`; any other version is reported and the file is not applied.

| Key | Meaning |
| --- | --- |
| `selection` | Baseline selection: `{ "mode": "auto" }`, `{ "mode": "manual", "profile": "<ref>" }` or `{ "mode": "off" }`. |
| `defaultProfile` | Profile used in `auto` mode when no binding matches. |
| `profiles` | Per-profile metadata: `extends` and `description`. |
| `bindings` | Array of `{ id, profile, priority?, match }`, at most 200. |
| `inheritGlobalBindings` | Project only. `false` makes the project ignore global bindings. |
| `subagents` | `off`, `bindings` (default) or `inherit`. |
| `display` | `hidden` (default) or `added`. Presentation only. |

Invalid values are reported and left unused instead of being repaired in place, and unknown keys are preserved with a warning. Writes go through one path: the file is re-read, the change is applied to the object that was read, and the result replaces the file atomically only if the bytes on disk are still the ones that were read. A concurrent edit is reported instead of being overwritten.

## Selection and bindings

The selection in force comes from, in order: a CLI flag for this run, the selection stored in the session branch (`/push use`, `/push auto`, `/push off`), then the config baseline — the project selection when the project is trusted and defines one, otherwise the global selection. A selection saved with `/push set selection` applies to new sessions; a session that already chose keeps its own.

In `auto` mode the profile is resolved per send, against the model in use:

1. Bindings in the project config, when the project is trusted, then bindings in the global config. A project with `inheritGlobalBindings: false` skips the global bindings.
2. Inside one scope, the highest `priority` wins (missing means 0), then the most specific matching rule. Specificity counts exact `provider` and `model` fields: both exact beats model only, then provider only, then two wildcards.
3. Two different profiles tied in the same scope are reported as a conflict and neither is applied from that scope; the resolution does not fall through to the global scope.
4. With no matching binding, `defaultProfile` from the project, then from the global config.
5. With nothing to apply, the message is sent as written.

A rule has an optional `provider` and `model`; an omitted field matches anything. `*` is the only wildcard and matches any run of characters, including `/` in a model id, so `deepseek/*` covers `deepseek/a/b`. Matching is full string, there are no other wildcards and no regular expressions. Rules inside a binding are OR-ed; `provider` and `model` inside one rule are AND-ed.

`manual` pins one profile for every new message regardless of the model. `off` adds nothing and also skips the pre-send check, so a broken config cannot block a send while Push is off.

`once` arms one profile for the next new message only. It wins over the selection, is consumed when that message is decorated, and is disarmed when Pi forks the session or the tree moves to another point, so an earlier branch cannot resurrect it. Cancelling a queued message or stopping a send in the pre-check does not consume it.

### CLI flags

`--push-profile <ref>`, `--push-auto` and `--push-off` set the selection for that Pi run. They live in memory for the process, write no session entry and leave the stored config alone. Passing more than one applies none of them and reports the conflict.

### Subagents

`subagents` only applies when the Pi process is a subagent child, which `pi-subagents` marks with `PI_SUBAGENT_CHILD=1`. `bindings`, the default, uses only an explicit binding that matches the child's model and ignores the session selection and `defaultProfile`; `inherit` resolves exactly as in the parent; `off` adds nothing. An explicit `off` selection wins in every case.

## `/push`

| Command | Effect |
| --- | --- |
| `/push` | Sectioned menu, described below. |
| `/push use <profile>` | Pin a profile for this session. |
| `/push auto` | Resolve from bindings and defaults again. |
| `/push off` | Stop adding text for this session. |
| `/push once <profile>` | Use the profile for the next message only. |
| `/push once off` | Cancel the profile armed for the next message. |
| `/push list [--scope global\|project]` | List profiles with their directories. |
| `/push new <id> [--prepend <text>] [--append <text>] [--scope …]` | Create a profile: with `--prepend` or `--append` it writes those files, and without them it writes nothing and reports the directory and how to write it. Text that would exceed the 64 KiB limit of a file is refused before anything is written. The id is used as the directory name, so it must use letters, digits, dot, dash and underscore, start with a letter or digit, and stay within 64 characters; an id that breaks the rule is refused and the message names the id the same name would produce, when one exists. An id that differs only in case from an existing profile in the same scope is refused too, because the filesystem may keep one directory for both. The menu entry "Create a profile" asks for a name instead: when the name is not already an id, it offers the derived one (`Pensamiento abstracto` → `pensamiento-abstracto`) and stores the typed name as the profile's `description` in `config.json`; a name that is already an id is used as it stands, with no description. |
| `/push edit <profile> [--part prepend\|append]` | Edit one part in Pi's editor. |
| `/push default <profile> [--scope …]` | Set `defaultProfile`. |
| `/push bind <profile> [--provider <p>] [--model <m>] [--priority <n>] [--id <id>] [--scope …]` | Add or replace a binding. |
| `/push unbind <id> [--scope …]` | Remove bindings by id. |
| `/push config [--scope …]` | Show a `config.json` and the effective settings. |
| `/push config set\|unset <key> [<value>] [--scope …]` | Write through the same path as `/push set`. |
| `/push set <key> <value> [--scope …]` | Change one setting. |
| `/push unset <key> [--scope …]` | Remove one setting. |
| `/push status` | Selection, origin, model, resolved profile, layers, binding, `display`, trust and diagnostics. |
| `/push why` | Explain why a profile does or does not apply to the current model. |
| `/push preview` | Print the exact text the next message would receive. |
| `/push show [n]` | Original and effective text of the n-th most recent decorated send on the branch. |
| `/push validate` | Report configuration problems. |
| `/push reload` | Re-read configuration and profiles from disk. |
| `/push help` | Print the command list. |

Settings that `set` and `unset` accept: `selection` (`auto` or `off`; `manual` has its own command), `display` (`hidden` or `added`), `subagents` (`off`, `bindings`, `inherit`) and `inheritGlobalBindings` (`true` or `false`, project config only). `defaultProfile` is written by `/push default`.

### The menu

`/push` without arguments opens a menu whose title carries the state, so the first row is always an action:

```text
Push · Active: <profile> (<session|auto|default>) · Next: <profile|none>
  Use a profile for this session…
  Next message: <profile|none>…
  Profiles…          browse (show text, edit, use, set as default), create, edit
  Model bindings…    bind the current model, remove a binding, list, inherit global bindings
  Settings…          where changes are saved, selection, default profile, subagents, added text
  Check and inspect… status, why, preview, last added text, configuration, check, reload
  Help
```

Every setting is changed from the menu, and nothing there writes to a message. The title reads `Active: off` for a session that adds nothing, and names the reason the profile applies: `(session)` for a pinned profile, `(auto)` for a binding, `(default)` for `defaultProfile`. Long references are shortened with `…` to keep the state on one line.

`Settings` starts with the row `Save changes to`, which picks the `config.json` every write from the menu uses — the project config when the project is trusted, the global one otherwise, and never the project when it is not trusted. It is remembered for the session, and settings, bindings and `defaultProfile` all follow it. A value the project does not store but the global config does is shown as `(from global)`, and its selector offers `Use global value (<value>)` to remove the project override; that is a separate choice from picking a value. The current value is marked `(current)`.

Esc and `Back` return one level and Esc at the title closes the menu. A setting change returns to `Settings` with the new value; choosing a session profile or arming one for the next message closes the menu and reports it. A profile is shown as `<id> (<scope>)`, so a profile named `Off`, `Back` or `Automatic` never reads like one of the menu's own rows.

`--scope` takes `global` or `project`. `/push new`, `/push set`, `/push unset` and `/push config` default to the global config; `/push bind` defaults to the scope of the profile it names and `/push default` to the scope of an explicit reference, then to global; `/push unbind` without `--scope` searches both. Writing the project config is refused when the project is not trusted.

Menus, profile editing and binding through the model picker need the interactive UI. Without it, the commands that would open a dialog report what to pass instead, and the report commands still print.

## Presentation

The stored message always contains the inserted text. What you see is a rendering of it.

- The native user row paints the text the message was sent with. A markdown transformer maps the stored text back to the original recorded for that message, in the live session and after reopening. When the mapping cannot be proven — the same text is also another message's original, or the message was changed after decoration — the row paints the stored text unchanged instead of guessing.
- `display: hidden` (the default) draws nothing extra.
- `display: added` draws one extra row above the message: `push-prompts: <profile> (active|once)`, then `added before:` and `added after:` with the inserted text. The renderer reads `display` when it paints, so changing the setting also affects rows for earlier sends.
- `/push show [n]` prints the original and the effective text of one decorated send on the active branch, counting back from the most recent. If another writer changed that message after Push recorded it, the command says so and prints only the effective text.

## Cache guarantee

**Guaranteed.** For every send, the serialized provider request differs from the request Pi would build with no extension loaded for the same session and the same new message only by the text inserted into that new message. History keeps its content, role, order and representation; the system prompt, tools, model, provider, parameters and cache fields are untouched; the effective text of the new message appears exactly once in the request.

**How it is tested.** `test/integration/cache-prefix.test.ts` runs the real extension against Pi's built-in Anthropic Messages, OpenAI Responses and Google Generative AI adapters, with `globalThis.fetch` replaced by a test transport that accepts only those routes and fails closed on anything else. For each measured send, the baseline is a copy of the candidate's saved session file opened with no extension at all, sending the same new message. The first send of a new session has no saved file yet, so there the baseline is a fresh plugin-free session holding the same empty history. The two serialized bodies are compared byte for byte: with no profile applicable they must be identical, and after removing exactly the effective text of the new message from the candidate the bodies must still be identical. The suite covers prepend, append, both and inherited text; editing a profile between sends; switching the selection off; `display` changes through `/push config`, the menu and the config file; `once` armed and cancelled; read-only commands between sends; a model switch to another provider's binding; and reopening the session with and without the extension. OpenAI's `prompt_cache_key` must equal each side's own session id, and is excluded only when the baseline is a fresh session rather than the same file.

**Not guaranteed.** A cache hit, a cache counter, or a provider's retention and eviction behavior. Compaction rewrites the history Pi sends. A model or provider switch starts a new request shape. Another extension can change messages or request fields. A message that never reaches `message_end` is not measured by this contract.

## Limits

- `display` changes presentation only. It is not a privacy measure.
- The session and the model always contain the added text. The original exists only as a rendering, so anything that reads the stored session — a copy of the file, an export, another tool, or Pi started without the extension — sees the added text.
- If another extension replaces the message after Push decorated it, the recording no longer matches: `/push show` reports it as modified and the native row paints the stored text, which is the decorated text.
- If decoration fails between the pre-check and the finalization, Push cannot stop the send: it warns and the message goes out undecorated.
- The extension fails closed. One diagnostic about any profile or config file stops every send, not only the one that file affects, because Push cannot tell what would have applied. The blocking notice names the diagnostic code and the file or profile it came from, `/push validate` lists every problem, and `/push off` always sends.
- Project configuration and profiles are read only when Pi trusts the directory; nothing from an untrusted project is used or written.
- Profiles are plain text with no extra authority. The text is inserted into the user message, so it is as trustworthy as the file it came from and cannot change tools, model, permissions or the system prompt.

## Development

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` runs Biome lint, `tsc --noEmit` and the test suite. The suite works in temporary directories with a synthetic transport, needs no API key and sends nothing over the network.

Some runs compare this extension with the sibling `pi-prompt-profiles` extension. They need a checkout of that repository and stay unregistered unless `PI_PROMPT_PROFILES_CHECKOUT` names one:

```bash
PI_PROMPT_PROFILES_CHECKOUT=/path/to/pi-prompt-profiles npm test
```

That checkout is never installed, edited or vendored: the harness reads its sources and its Git history.

## Documentation, support and license

- [docs/compatibility.md](https://github.com/Yivas/pi-push-prompts/blob/main/docs/compatibility.md): Pi and Node versions, providers tested, items not run, public APIs used.
- [SECURITY.md](https://github.com/Yivas/pi-push-prompts/blob/main/SECURITY.md): what sessions contain, how configuration is trusted, how to report a concern.
- [CHANGELOG.md](https://github.com/Yivas/pi-push-prompts/blob/main/CHANGELOG.md): user-facing changes per release.
- [schema/config.schema.json](https://github.com/Yivas/pi-push-prompts/blob/main/schema/config.schema.json): JSON Schema for `config.json`.

Support and contributions go through GitHub. Open an [issue](https://github.com/Yivas/pi-push-prompts/issues) for a bug or a proposal, and read [CONTRIBUTING.md](https://github.com/Yivas/pi-push-prompts/blob/main/CONTRIBUTING.md) before sending a pull request. Everyone taking part is expected to follow the [Code of Conduct](https://github.com/Yivas/pi-push-prompts/blob/main/CODE_OF_CONDUCT.md). Security problems must not go to the public tracker: report them through [GitHub's private vulnerability reporting](https://github.com/Yivas/pi-push-prompts/security/advisories/new), as [SECURITY.md](https://github.com/Yivas/pi-push-prompts/blob/main/SECURITY.md) describes.

Released under the [MIT License](https://github.com/Yivas/pi-push-prompts/blob/main/LICENSE). Files derived from `pi-prompt-profiles` keep their per-file header naming that source, which carries the same MIT license and copyright holder.
