# Agent Note: The gates that went red as `main` advanced

Status: implemented

## Problem

A push to `main` failed six of its CI jobs — every job that runs the full gate set, plus the issue-lifecycle workflow and the Python runtime smoke. The failures had five unrelated causes, and only one of them was visible on a developer machine.

The static and Windows lanes failed `doc graphs`: `docs/event-producer-consumer.md` no longer matched `pnpm run gen-doc-graphs`.

The coverage and Windows lanes failed `@hydra/harness-hooks-claude-code/config` with `Cannot find package`. The coverage lane installs and runs tests with **no build step**, so a specifier that resolves through a package's `exports` map to a `lib/` file has nothing to resolve to. Locally it never showed: a developer tree has `lib/` from an earlier build. The specifier resolved to `packages/hooks/hooks-claude-code/config/src` because `tsconfig.base.json`'s generic `@hydra/harness-*` wildcard substitutes the whole remainder — `hooks-claude-code/config` — into the package directory. Its sibling dialect had the explicit entry ([`@hydra/harness-hooks-codex/config`](../../../../tsconfig.base.json)); this one never got it.

The same lanes failed `api-key-fallback.spec.ts` with `The iterator does not provide a 'throw' method`: `yield* chunks` delegated to a plain array iterator, so a consumer's `.throw()` reached the array instead of the generator. Node 22.19 tolerates it; Node 24, which the primary lane runs, does not.

The coverage lane also failed the shipped-tool catalog for missing `browser_fill`, `browser_find`, and `browser_forward`.

The issue-lifecycle workflow failed before running any policy code: `create-github-app-token` refuses an empty `client-id`, and this repository has no `HYDRA_ISSUE_APP_CLIENT_ID` variable, so every issue and pull-request event red-lit the check.

## Decision

`tsconfig.base.json` carries the explicit subpath alias the Codex dialect already had, so the specifier resolves to `src/config.ts` the way every other source-level import does, with no build required.

`api-key-fallback.ts` yields buffered chunks one at a time instead of delegating. The delegation was only ever a shortcut for replaying an array; yielding directly keeps the generator's own `.throw()` on the path the caller wrote, independent of Node version.

`gen-tool-catalog.spec.ts` expects the three browser tools the catalog actually boots.

`issue-lifecycle.yml` gates its two App steps on `vars.HYDRA_ISSUE_APP_CLIENT_ID != ''`, so a repository without the App installed skips them and reports success instead of failing. The workflow re-arms on its own the moment the variable is set; `scripts/ci-workflow.spec.ts` pins the new condition.

`docs/event-producer-consumer.md` is regenerated.

## Alternatives considered

**Build every package before the coverage lane runs tests.** Rejected: it would put a full `tsc -b` in front of the lane whose whole value is running the tests, and the source-level alias is the mechanism every other subpath import in this repository already relies on.

**Have the coverage lane import the package root instead.** Rejected: the root does not re-export `parseClaudeCodeConfig`, so this would widen a public surface to work around a missing alias.

**Change the generic wildcard to stop at the package name.** Rejected here: the wildcard is shared by every package, and narrowing it would need the explicit entries the affected packages are missing — a repository-wide audit, not a CI repair.

**Wrap `yield*` in a try/catch to translate the TypeError.** Rejected: the error the consumer passed is the one that must surface; translating a delegation artefact would report a different failure than the caller's.

**Delete the App steps from `issue-lifecycle.yml`.** Rejected: the board automation is intended work, merely unconfigured. Gating on the variable keeps it one repository variable away from running.

## Consequences

The static, Windows, coverage, and Python lanes lose the doc-graph, module-resolution, iterator, and catalog failures; the issue-lifecycle check stops reporting failure on a repository that has not installed the App. Nothing about the browser, the desktop, or the runtime changed shape.

The gates did **not** all go green. The coverage lane still fails its per-file 100% branch thresholds on files unrelated to these fixes, the snapshot lanes still carry stale web goldens, and the Python runtime smoke still reports `model-visible.json` stale. Those are recorded under Deferred rather than papered over.

Refreshing goldens is **not** a safe blanket remedy here: `HYDRA_SNAPSHOT=refresh` over the snapshot lane rewrote six acp-agent session logs with this machine's absolute temp paths where the committed goldens carry `{{cwd}}`, so a refresh must be diffed and its machine paths reverted before it can be kept.

## Testing

`pnpm run check:ci:static` passes 35/35. `tsc -b tsconfig.host.json` is clean. `gen-tool-catalog.spec.ts` (10), `api-key-fallback.spec.ts` (9), `ci-workflow.spec.ts` (18), and `hooks-registry/tests/registry.spec.ts` (22) pass. The alias is proven load-bearing by hiding `lib/types/config.{js,d.ts}` and re-running the registry suite: it still passes, which is the state CI is in.

## Deferred

Per-file branch coverage below the 100% threshold in `prompt-revisions.ts`, `ui-settings-plugins`, `WebSearchCard`, `PersonalizationSection`, `page-agent-llm.ts` and others; the stale web `ui.expected.md` goldens; `scripts/snapshots/python-sdk-single-exe/minimal/model-visible.json`, which needs a Linux single-executable build to regenerate; and the two real-shell pwsh suites that only run on Linux.

## Related

[Direct omnibox navigation without a chat owner](2026-09-12-omnibox-navigation-without-chat-owner.md) is the other half of what the same `main` push carried.
