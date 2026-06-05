## What this changes

<!-- One sentence: what's different after this PR vs before. -->

## Why

<!-- The motivation: bug being fixed, feature being added, refactor
justification. Link to the issue if there is one (`Fixes #N`). -->

## How I tested

<!-- What you actually did to verify. Concrete: "ran the new render path
on a 3-min OBS recording, confirmed cuts at 0:34 and 1:12" beats "tested
locally." Include `uv run pytest` + `bun run tsc --noEmit` if you touched
those layers. -->

## Anything reviewers should pay attention to

<!-- Tricky logic, decisions you're unsure about, follow-ups deferred
to a later PR, breaking changes to JSON contracts, etc. -->

## Checklist

- [ ] Added/updated tests for new pure-logic helpers (`tests/`)
- [ ] `uv run pytest` passes locally
- [ ] `bun run tsc --noEmit` passes locally (if frontend touched)
- [ ] Type hints on new Python; strict TypeScript on new TS
- [ ] No new dependencies, or the new dep is justified above
- [ ] No secrets / personal paths in the diff
