## What changes and why

<!-- The behavior before and after, and the problem it solves. -->

## Verification

<!-- The commands you ran and what they reported. Paste `npm run check` output or its summary. -->

- [ ] `npm run check` passes
- [ ] New or changed behavior has a test at the point where it is observable

## Compatibility

<!-- Pi version and operating system used. Note anything that depends on the Pi extension API, and what you did not run. -->

- [ ] The tested Pi version in `devDependencies` is unchanged, or the change says why it moved
- [ ] `docs/compatibility.md` and `CHANGELOG.md` are updated when a documented promise changed

## Checklist

- [ ] The change stays inside the extension's contract: only the new user message is decorated, and the system prompt, tools, model, thinking level and cache settings are untouched
- [ ] The docs describe the behavior the code now has, including limits
- [ ] Risks, breaking changes and compatibility are stated above
- [ ] No real prompts, profiles, credentials, session IDs or private paths are included

Security problems must not be reported here; follow [SECURITY.md](https://github.com/Yivas/pi-push-prompts/blob/main/SECURITY.md).
