# Agent Note: Jev decision capability and Models provider contribution

Status: implemented

## Problem

TypeSafe Jev answers unary choice, score, and yes/no questions. It does not implement Hydra's streaming `LlmAdapter`, so exposing it as a chat provider would make the model picker advertise a route that cannot produce conversation output. Browser decisions also need to remain advisory so an unavailable optional service cannot disable ordinary browser execution.

## Decision

`@hydraharness/harness-jev` provides `ctx.jev.systemOne()` as an optional Host capability. It calls Jev's documented `POST /api/v1/decisions` endpoint with a credential reference, `typesafe-ai/jev` default model, timeout, cancellation, response-envelope validation, and safe typed errors. Settings and credentials are optional: the plugin boots without either service, and a missing key fails only the decision request.

`@hydraharness/harness-browser-decisions` is a separately packaged optional consumer in the base bundle's `jev` plugin group. Its `browser_decide` tool asks Jev to choose from candidate labels and returns an unavailable result when Jev is absent or fails. It never navigates, clicks, creates selectors, changes permissions, or bypasses browser policy.

`@hydraharness/harness-client-ui-jev` registers the `settings.models.provider-option` slot. The Models page renders `Jev` in its Add provider dropdown only while this contribution is mounted. Its editor writes the key through the existing Credentials API and keeps the key out of settings, session state, and browser-readable configuration. The option is outside `ctx.llm`, `session.models`, and the conversation model picker. Host JEV, the browser-decisions consumer, and the UI contribution use the shared `pluginGroup: jev`.

The provider-option slot also renders configured rows from value-free credential states. The Models page describes whole-section provider credential references alongside LLM references, and Jev contributes a row only when its configured reference is confirmed present. The shared page refresh handles credential events and reloads; Edit selects the contribution's existing write-only editor. No browser-local saved flag or LLM adapter registration establishes presence.

The Jev provider, browser-decisions consumer, and Models contribution share one inventory group, so enabling that group mounts the bounded browser decision path after the normal core-plugin restart. Disabling the group removes its service, tool, and UI slot through normal Cordis disposal. Existing browser tools and model routes remain unchanged in the disabled and keyless states.

## Alternatives considered

**Register Jev as an `LlmAdapter`.** Rejected because Jev returns structured decisions rather than Hydra text/reasoning/tool-call streams.

**Embed browser behavior in the Jev provider.** Rejected because the provider is useful to other consumers and browser authority belongs to the existing browser executor and policy.

**Add a Jev-specific branch to `ModelsSection`.** Rejected because the typed provider-option slot lets optional providers add one dropdown entry and card without coupling the page to their implementation.

**Add retries, a model catalog, or automatic browser invocation.** Deferred under YAGNI; callers can retry deliberately and the first consumer only needs one candidate-choice workflow.

## Consequences

Jev is available to future consumers through one small capability while the normal LLM route and replay contracts stay stable. The Models page owns selection, credential refresh, and lifecycle, while the Jev contribution owns its credential row and write-only editor. The decision tool can abstain, so missing optional infrastructure preserves the existing agent path. The provider's direct `fetch` keeps the dependency closure small, but the API response validator must track the TypeSafe wire fields used by consumers.

## Testing

The Host and consumer packages compile in the Host aggregate, and the UI contribution compiles in the Client aggregate. Focused component and store tests cover non-chat credential state and configured rows. The assembled Web scenario saves a key through the real Host, verifies the row after page reload, reopens the editor without exposing the key, and observes removal after credential deletion. Provider and browser-consumer tests cover successful response projection and missing-service abstention; live provider calls remain opt-in.
