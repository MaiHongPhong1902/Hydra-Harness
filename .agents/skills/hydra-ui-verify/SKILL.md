---
name: hydra-ui-verify
description: Verify changed Hydra-Harness UI using focused tests, real browser interactions, and Electron checks when desktop behavior is affected. Use after UI implementation or when asked whether a screen or flow actually works; not as a full-CI claim.
---

# Hydra UI Verify

Use the current Hydra-Harness checkout and preserve unrelated changes. Paths and commands below are repository-relative. Read the [testing policy](../../../docs/testing.md) and the relevant portions of [Hydra Pre-Push Checks](../hydra-pre-push-checks/SKILL.md) to select evidence for the actual diff.

## Match evidence to the change

Inspect the current package scripts, owning tests, and build configuration before running commands. Source-plane tests and built-client interaction tests establish different facts. Verify that browser tests load artifacts containing the change; reuse valid builds and rebuild only the affected artifacts through the repository's supported workflow. Avoid concurrent commands that write the same build outputs.

| Changed surface | Relevant evidence |
|---|---|
| Native field or dropdown markup | `pnpm run verify-ui-controls`, then the owning interaction checks. |
| Component, store, or persistence behavior | Focused owning Vitest tests; trace the real Host acknowledgement for saves. |
| Shared control CSS or theme | Real browser computed styles and screenshots on affected screens, both themes, and a narrow supported viewport. |
| User-visible state or transcript | The owning keyless snapshot through the assembled application. |
| Desktop panels, Files, or terminal controls | The owning Electron interaction or smoke, in addition to relevant component tests. |
| Documentation or Agent Notes | The repository's documentation gates, including `pnpm run doc-sync` when required. |

The [Web test scaffold](../../../apps/web/tests/scaffold.ts) provides isolated assembled Web fixtures. Inspect a nearby scenario before adding a new one. The [UI controls scenario](../../../apps/web/tests/ui-controls.e2e.ts) covers shared control chrome; it does not cover every feature's behavior.

A focused control replay, after the required artifacts are current:

```powershell
$env:HYDRA_SNAPSHOT = 'replay'
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/ui-controls.e2e.ts
```

Choose additional files from the changed feature, rather than copying a fixed whole-repository test list. After a valid build, the existing desktop smoke is `pnpm --filter @hydraharness/harness-desktop run smoke`; give state-changing smoke runs a temporary `HYDRA_HOME` instead of the user's profile.

## Observe meaningful behavior

Exercise the actual affected path: entry, selection or typing, submission, acknowledgement, and the promised reload or cancellation behavior. Include error, disabled, and read-only states where relevant. For composite inputs, inspect the wrapper's focus ring and geometry, not just the inner input.

Inspect screenshots as well as assertions. Check clipping, label relationships, long values, menu placement, and focus rings. Native selects may expose platform-specific computed line heights or popup rendering; compare supported geometry and behavior instead of forcing a custom replacement to satisfy a CSS-string expectation. Compare resolved colors rather than raw CSS token spellings.

Use fixture credentials and local or recorded responses for deterministic tests. Report external provider availability separately. A successful mocked request proves wiring, not live service health; a stored key proves neither authentication nor quota availability.

## Handle results

When a check fails, distinguish a product regression, an intentionally obsolete expectation, and an environment limitation. Fix the demonstrated cause. Refresh only the intended snapshot after inspecting its output, then verify replay; do not broadly rewrite goldens or normalize away failures.

Rerun checks invalidated by a fix, without repeating unrelated passing suites. A style-classification gate cannot establish correct rendering, jsdom cannot establish native behavior, and a browser replay cannot establish Electron integration or full CI health.

Report exact checks run and the scope of their results. Keep source tests, built browser evidence, native Electron evidence, live providers, and CI status separate. For a GUI pull request, follow the [Record Browser GIF](../record-browser-gif/SKILL.md) requirement; a GIF is not required merely to validate a local change.
