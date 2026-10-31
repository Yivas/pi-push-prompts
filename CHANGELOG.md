# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows the `0.y.z` convention used by its author: `PATCH` for compatible fixes, `MINOR` for features or breaking changes.

## [Unreleased]

### Changed

- The menu entry "Create a profile" asks for a name and, when that name is not already an id, offers the id derived from it (`Pensamiento abstracto` → `pensamiento-abstracto`) instead of failing. The dialog title states the id rule before anything is typed, and the typed name is stored as the profile's `description` in `config.json` only when it is not already the id. A name no id can be derived from reports the rule in one message.
- `/push new <id>` stays strict: the directory is created with exactly the id given, and an id that breaks the rule is refused with a message that states the rule and names the id the same name would produce, when one exists.
- Creating a profile refuses an id that differs only in case from an existing profile in the same scope, in the menu and in `/push new`, because the filesystem may keep one directory for both.

## [0.1.0] - 2026-10-31

First public release, MIT licensed, distributed as `pi-push-prompts` and installable with `pi install npm:pi-push-prompts@0.1.0`.

### Added

- Profile text inserted into the new user message itself, as a prepend, an append, or both, with one blank line between your text and the profile text. Profiles live as `prepend.md` and `append.md` under `<agentDir>/push-prompts/profiles/<id>/` and, for a trusted project, under `<cwd>/.pi/push-prompts/profiles/<id>/`.
- One parent per profile through `profiles.<id>.extends`, resolved inside the same scope, limited to 8 profiles and 256 KiB of joined text. A missing parent or a cycle discards the profile instead of dropping a layer.
- Selection per session, stored in the session branch: a pinned profile, an automatic mode resolved from provider/model bindings and a default profile, or off. `once` arms one profile for the next new message and is consumed by it.
- Automatic mode: bindings with `priority`, provider and model rules where `*` is the only wildcard, a conflict reported instead of silently picking one profile, and the project's `defaultProfile` before the global one.
- `/push` with `use`, `auto`, `off`, `once`, `list`, `new`, `edit`, `default`, `bind`, `unbind`, `config`, `set`, `unset`, `status`, `why`, `preview`, `show`, `validate`, `reload` and `help`, plus a menu when it runs without arguments.
- Non-interactive flags `--push-profile`, `--push-auto` and `--push-off` for one Pi run, and the `subagents` setting with `off`, `bindings` and `inherit` for a `PI_SUBAGENT_CHILD` process.
- A versioned `config.json`, validated by `schema/config.schema.json` and written through a read-compare-replace path that reports a concurrent edit instead of overwriting it.
- Read-only presentation: the native user row paints the original text of a decorated message, and `display: added` adds a row naming the profile that applied. `/push show` prints both versions of a recent decorated send.
- Session entries `push-prompts.applied` and `push-prompts.state`, so a reopened session keeps what was inserted and which profile applied.
- A refused write: profile text that would push `prepend.md` or `append.md` over the 64 KiB limit the loader applies is not written, instead of leaving a file the loader would drop with a `profile-too-large` diagnostic.

### Guarantees

- For every send, the serialized provider request differs from the request Pi would build with no extension for the same session and message only by the text inserted into that new message. The system prompt, tools, model, provider, parameters and cache fields are untouched, and the effective text appears exactly once. Measured against a plugin-free baseline over the same saved session, byte for byte, on Pi's Anthropic Messages, OpenAI Responses and Google Generative AI adapters.
- A message already in the session keeps its content, role, order and representation. Editing a profile, changing the selection or turning Push off affects the next new message only.
- Retries, continuations after a tool call, compaction, reload and reopening the session do not decorate again.

### Limits

- No cache hit, cache counter or provider retention is promised. Compaction rewrites the history Pi sends, a model or provider switch starts a new request shape, and another extension can change messages or request fields.
- `display` changes presentation only. The session and the model keep the added text, so anything reading the stored session sees it.
- If decoration fails between the pre-check and finalization, the send is not stopped: Push warns and the message goes out undecorated.
- The extension fails closed. A diagnostic about any profile or config file stops every send until it is fixed, and the blocking notice names the diagnostic code and the file or profile it came from. `/push validate` lists the problems and `/push off` always sends.
- Profile text is inserted into the user message, so it is as trustworthy as the file it came from. It cannot change tools, permissions, model, provider or the system prompt. Project configuration and profiles are read only when Pi trusts the directory.
- Tested on Pi 1.4.0 with a simulated outbound transport and no network calls. Terminal painting, real provider traffic, a real subagent child process, a published-package install and platforms other than Windows were not part of those runs. `docs/compatibility.md` carries the full list.
