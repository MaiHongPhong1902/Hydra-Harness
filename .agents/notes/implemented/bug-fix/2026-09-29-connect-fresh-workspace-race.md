# Agent Note: `connectFreshWorkspace` returned before the workspace pick landed

Status: implemented

## Problem

`node 24 / snapshots and artifacts` (`check:ci:consumers`) has never passed a single hosted CI run on `main`. Reproducing it locally (Windows, and a from-scratch Linux container matching the hosted runner) surfaced a wide, seemingly unrelated spread of `apps/web` e2e failures: stale hero-chip text (`"Choose workspace"` instead of the picked folder name), missing `subagent` publish events, `llm-replay` fixtures left with unconsumed recorded turns, and more, across roughly a dozen distinct spec files.

All of them shared one call: `connectFreshWorkspace` (`apps/web/tests/support.ts`), used by 43 spec files to pick a workspace before the rest of the scenario runs. Its last step waited for `[data-composer-card]` to appear before returning. That element is mounted unconditionally by `InputBar` — the same comment in `ConversationRoot.tsx` documenting this says "the bar is ONE session-maybe slot rendered unconditionally... so the textarea DOM survives the transition" — and it is the very element `connectFreshWorkspace` clicks at the *start* of the function (via the `role=textbox, name="Choose workspace"` locator) to open the picker. So the wait resolved immediately, before the picked workspace's `chipTitle` had actually propagated through session/workspace state. Every caller proceeded as soon as the dialog closed, racing whatever came next against that propagation.

## Decision

**Wait for the disabled trigger textbox's accessible name to stop being `"Choose workspace"` instead.** `WorkspaceChip`'s `aria-label` is a constant, but the composer `<textarea>` in `InputBar.tsx` only carries `aria-label={workspaceTrigger ? t('hero.chooseWorkspace') : undefined}` — `workspaceTrigger` (hence `inert`, hence this label) flips false the moment `chipTitle` resolves from the pick, independent of whether a model has been selected yet (several callers, e.g. `onboarding-usable-provider.e2e.ts`, exercise the no-model-yet state right after connecting). Waiting for `page.getByRole('textbox', { name: 'Choose workspace' }).waitFor({ state: 'detached' })` is therefore the one signal every one of the 43 callers can rely on.

## Consequences

A single shared-helper fix rather than 43 per-test patches. Spot-checked against 5 previously-failing spec files after the change: `sidebar-subagent-activity.e2e.ts`, `subagent-conversation.e2e.ts`, and `subagent-interrupt-ui.e2e.ts` now pass outright; `agent-preset-selection.e2e.ts`'s hero-chip golden (previously mismatching on `"workspace"` vs `"Choose workspace"`) now passes without any golden change. Remaining local failures in the same batch (`file-review.e2e.ts`'s narrow-panel button count, `auth-accounts.e2e.ts`'s calendar-date golden, and anything showing `unknown tool "bash"`) are unrelated: the first two are pre-existing, separately scoped issues, and the last is this Windows checkout resolving the shell capability as `pwsh` rather than `bash` — not reproducible on the Linux-only hosted job.

## Alternatives considered

**Waiting on `[data-composer-card]`'s `disabled`/enabled state instead.** Rejected: several callers intentionally interact with the still-disabled, no-model-selected composer right after connecting a workspace; gating on "enabled" would hang or misfire for those.

**Patching each of the 43 call sites' post-pick assertions with its own extra wait.** Rejected: the race is in the shared helper, not in any individual caller; fixing it once there is the smaller, root-cause diff.

## Verification

`pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-preset-selection.e2e.ts` (7/7 passed, previously 1 failing) and the sidebar/subagent-conversation/subagent-interrupt-ui batch above (3/3 files newly passing) on a Windows checkout. Full-suite confirmation on the Linux hosted runner is pending the next `fix/ci-green` CI run (PR #26).
