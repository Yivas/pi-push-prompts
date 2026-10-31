# Contributing

Bug reports, proposals and pull requests are welcome through GitHub issues and pull requests.

## Before you start

- Check that the change fits the scope described in [README.md](README.md) and that [docs/compatibility.md](docs/compatibility.md) does not already record it as a known limit.
- Read [docs/compatibility.md](docs/compatibility.md) before changing anything that depends on the Pi extension API. The contracts documented there come from the installed Pi version, not from an older memory of it.
- Never paste real profiles, credentials, session IDs, endpoints or logs into an issue, a pull request or a test fixture. Use synthetic examples.
- Security problems do not belong in a public issue; see [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` runs Biome lint, `tsc --noEmit` and the suite in `test/`. The suite works in temporary directories with a synthetic transport, needs no API key and sends nothing over the network.

One comparison group needs a second repository: `test/integration/coexistence.test.ts` loads the sibling `pi-prompt-profiles` extension from a checkout named by `PI_PROMPT_PROFILES_CHECKOUT`.

```bash
PI_PROMPT_PROFILES_CHECKOUT=/path/to/pi-prompt-profiles npm test
```

Without the variable those cases report a skip and the rest of the suite still runs. The checkout is only read: nothing there is installed, edited, vendored or added as a dependency. The workflow checks out that repository at a fixed commit, so the same comparison runs on CI.

Every suite clears `PI_PACKAGE_DIR` before Pi loads, so a run measures the Pi version `package.json` dev-pins instead of a global install. The coexistence harness goes further and fails loudly when Pi reports a different version. Keep that import order when you edit the tests, or the run will measure a different Pi.

## Reporting a bug

Open an issue and include:

- the Pi version (`pi --version`) and the package version;
- the operating system;
- the commands or files that reproduce the problem, with private data removed;
- what you expected and what you observed;
- what `/push status` and `/push validate` print, when the problem is about which profile applies or how the configuration is read.

Say what else was loaded in the session. Another extension that also changes the new user message or the system prompt can explain a difference that Push did not cause.

## Pull requests

- Keep one coherent change per pull request.
- Add or update tests where the behavior is observable, and say what you did not run.
- Run `npm run check` and paste the result. The workflow repeats it on Node.js 22.19.0 and 24.
- Describe what changed, why, and how you verified it.
- Do not add dependencies without a concrete reason, and keep the tested Pi version pinned in `devDependencies`.
- Say so explicitly when a change affects the cache contract, the stored session entries, the configuration schema or the text a command prints. Those are documented promises, and the documentation has to move with them.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
