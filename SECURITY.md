# Security

| Surface | Support |
| --- | --- |
| `0.2.x`, distributed as the npm package `pi-push-prompts` | Fixes in the latest `0.2.x` release |
| Older versions | None; upgrade to the current `0.2.x` release. `0.1.0` was the first release |
| Pi versions | 1.4.0 only, see [compatibility](https://github.com/Yivas/pi-push-prompts/blob/main/docs/compatibility.md) |

## Scope

In scope:

- a path that reaches outside the authorized profile roots, including through a symlink;
- reading project configuration or project profiles from a directory Pi has not trusted;
- overwriting unrelated keys when a command writes `config.json`;
- a profile that is silently truncated or altered beyond the normalization described in the [README](https://github.com/Yivas/pi-push-prompts#where-the-text-lands);
- inserted text reaching a message other than the new user message Pi is finalizing.

Out of scope:

- Pi's trust decision itself, which belongs to Pi;
- other extensions running in the same process;
- the model's obedience to the inserted text;
- what anything reading the stored session sees. `display: hidden` changes only what the terminal paints.

The extension fails closed on purpose. A diagnostic about any profile or config file stops every send until it is fixed, because Push cannot tell what would have applied; the blocking notice names the diagnostic code and the file or profile it came from. `/push validate` lists the problems, and `/push off` always sends.

## What the extension reads and writes

- It reads `config.json` and the profile markdown under `<agentDir>/push-prompts/` and, only when Pi trusts the directory, under `<cwd>/.pi/push-prompts/`. An untrusted project contributes nothing: its configuration and its profiles are neither read nor written.
- It writes `config.json` through one path that re-reads the file, applies the change to what was read, and replaces the file atomically only when the bytes on disk are unchanged, so a concurrent edit is reported instead of overwritten. Unknown keys are preserved.
- It writes profile files only through the profile creation and edit commands, and only inside the root of the chosen scope. A path that resolves outside that root through a symlink is refused.
- It stores session entries: `push-prompts.applied`, one per decorated message, and `push-prompts.state`, holding the session selection and `once`.
- It makes no network calls, starts no processes or timers, and sends no telemetry. The only environment variable it reads is `PI_SUBAGENT_CHILD`, which marks a subagent child process.

## Sessions contain sensitive text

A decorated message is persisted with the inserted text, so the session file holds what was actually sent. Each `push-prompts.applied` entry also records the exact text inserted at each side, the profile reference, the mode (`active` or `once`), the provider and model used to resolve it, the message timestamp, and SHA-256 digests of the original and the effective content. Image attachments are not copied into the entry; their data appears only inside a digest.

Treat a session using this extension as containing both versions of every decorated message plus the profile that produced it. Do not commit session files or paste them into reports, issues or chat without reviewing them first.

`display: hidden` is the default and only changes what the terminal paints. The stored message, the model request and anything else that reads the session keep the added text.

## Configuration and profile trust

Project configuration and project profiles come from a repository, so they are read only when Pi trusts that directory. A profile is plain text inserted into the user message: it cannot change tools, permissions, model, provider or the system prompt, but it is as trustworthy as the file it comes from.

## Test harness

The tests run against temporary directories outside the real home directory, with placeholder credentials and `globalThis.fetch` replaced by a synthetic transport that accepts only the routes the built-in adapters use. Any other outbound request fails the test instead of being sent. That interception runs inside the test process; it is not an operating-system network sandbox. The suite loads no personal configuration or skills, and it refuses to start when it cannot create a sandbox outside the real home.

The coexistence runs read a separate checkout of `pi-prompt-profiles`, named by `PI_PROMPT_PROFILES_CHECKOUT`. That checkout is never installed, edited or vendored, and those runs stay unregistered when the variable is unset.

## Reporting a concern

Use GitHub's private vulnerability reporting on this repository (Security → [Report a vulnerability](https://github.com/Yivas/pi-push-prompts/security/advisories/new)). Do not open a public issue for a security problem. Include the affected version, the platform, a minimal reproduction, the impact you observed and any workaround you know. Remove credentials, private endpoints, conversation content and personal paths.

There is no bug bounty, service-level agreement or CVE commitment. The maintainer reviews the scope before deciding on remediation or disclosure.
