# Agent Note: official DeepSeek is dismissible

Status: implemented

## Problem

The shipped `deepseek-official` route is a whole-section composition default under `llm-deepseek`. The Models page treated a row as configured whenever that empty settings path resolved, and as deletable only when the user layer alone carried a nested profile. Official DeepSeek therefore had no Delete action. Closing the first-run setup card only hid it for the current session, and the [official DeepSeek credential step](2026-07-30-deepseek-onboarding-credential-setup.md) asked for a key again whenever no other provider was usable. Unsetting the whole `llm-deepseek` section would fight the composition base and recreate the row on the next describe.

## Decision

**Official DeepSeek stays mounted and becomes hideable.** `llm-deepseek` remains in the base composition, and `agent-default-model` keeps pointing at `deepseek-official`. The Models join still lists that directory entry, but `ui-onboarding.deepseekOfficialDeclined` (the same Host namespace as [welcome acknowledgement](2026-07-30-versioned-gui-welcome-onboarding.md)) makes it `configured: false`, so it leaves the row list for **Add provider** instead of occupying a permanent row.

**Delete records the hide flag instead of unsetting the composition section.** Nested pi-ai profiles still unset their user-layer path as the [web configuration plane](../architecture/2026-07-30-web-config-plane.md) already specified. Confirmation for official DeepSeek unsets a page-managed `DEEPSEEK_API_KEY` first when it can identify one, then `settings.mutate` sets `deepseekOfficialDeclined: true`. Environment credentials, custom references, and unidentified targets remain untouched, matching the existing credential-ownership rule.

**The shared model catalog honors the same flag.** The API proxy omits the official DeepSeek group and its discovery failures from both `session.models` and `llm.models` while dismissed. Existing settings invalidations refresh open selectors. The adapter, default, and logged selections remain available for dispatch; hiding selectable models does not remove provider capability or infer readiness from a missing credential. Host RPC regression coverage and the keyless `onboarding-usable-provider` browser snapshot exercise dismissal and restoration beside another configured provider.

**Re-adding clears the flag.** A successful Apply on the official DeepSeek editor while the flag is set unsets `deepseekOfficialDeclined` before reload, so the row returns. Closing Settings writes no durable dismissal; [provider-choice onboarding](../bug-fix/2026-09-07-provider-choice-onboarding.md) opens the full configuration page when no provider is usable.

**Onboarding follows the same join.** After any usable provider, a recorded dismissal projects `unavailable` / `provider-declined` and completes the step without prompting. The adapter remains repairable from Models through **Add provider**.

## Alternatives considered

**Unload `llm-deepseek` from the base composition.** Rejected because demos, e2e, default agent model, and web search still name `deepseek-official`; hiding the Models row is the product change, not withdrawing the adapter.

**Unset the whole `llm-deepseek` user section.** Rejected because the composition base would restore the profile on the next describe, so the row would return immediately.

**Process-local hide only.** Rejected because a reload or new session would recreate the row and the first-run prompt.

**Persist dismissal on onboarding Configure later.** Rejected because that action completes only the current coordinator pass; hiding the Models row is an explicit Delete.

## Consequences

The official DeepSeek row shows Delete next to Edit. Confirming it removes a managed file credential when identified, stores `deepseekOfficialDeclined` in `$HYDRA_HOME/settings.yaml`, drops the row, leaves provider editors closed, and leaves the Cordis plugin mounted. Adding DeepSeek again from the dormant-directory select clears the flag. Remote browsers that cannot write `ui-onboarding` still fail the hide write in the confirmation dialog, matching the existing loopback-only onboarding namespace. Store, readiness, React, and Host schema tests pin the join, the mutate shape, re-add, and the skipped prompt; keyless Web ARIA goldens now include the Delete control on that row.
