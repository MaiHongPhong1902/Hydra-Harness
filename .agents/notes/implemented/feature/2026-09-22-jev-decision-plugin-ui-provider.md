# Agent Note: Jev decision capability and Models provider contribution

Status: implemented

## Problem

TypeSafe Jev answers unary choice, score, and yes/no questions. It does not implement Hydra's streaming `LlmAdapter`, so exposing it as a chat provider would make the model picker advertise a route that cannot produce conversation output. Browser decisions also need to remain advisory so an unavailable optional service cannot disable ordinary browser execution.

## Decision

`@hydra/harness-jev` provides `ctx.jev.systemOne()` as an optional Host capability. It calls Jev's documented `POST /api/v1/decisions` endpoint with a credential reference, `typesafe-ai/jev` default model, timeout, cancellation, response-envelope validation, and safe typed errors. Settings and credentials are optional: the plugin boots without either service, and a missing key fails only the decision request.

`@hydra/harness-browser-decisions` is a separate optional consumer. Its `browser_decide` tool asks Jev to choose from candidate labels and returns an unavailable result when Jev is absent or fails. It never navigates, clicks, creates selectors, changes permissions, or bypasses browser policy.

`@hydra/harness-client-ui-jev` registers the `settings.models.provider-option` slot. The Models page renders `Jev` in its Add provider dropdown only while this contribution is mounted. Its editor writes the key through the existing Credentials API and keeps the key out of settings, session state, and browser-readable configuration. The option is outside `ctx.llm`, `session.models`, and the conversation model picker. Host JEV and the UI contribution use the shared `pluginGroup: jev`; `browser-decisions` remains an independent plugin.

The Jev provider and Models contribution share one inventory group, so enabling that group mounts both after the normal core-plugin restart. The browser-decisions consumer remains an independent optional row. Disabling either removes its service, tool, or UI slot through normal Cordis disposal. Existing browser tools and model routes remain unchanged in the disabled and keyless states.

## Alternatives considered

**Register Jev as an `LlmAdapter`.** Rejected because Jev returns structured decisions rather than Hydra text/reasoning/tool-call streams.

**Embed browser behavior in the Jev provider.** Rejected because the provider is useful to other consumers and browser authority belongs to the existing browser executor and policy.

**Add a Jev-specific branch to `ModelsSection`.** Rejected because the typed provider-option slot lets optional providers add one dropdown entry and card without coupling the page to their implementation.

**Add retries, a model catalog, or automatic browser invocation.** Deferred under YAGNI; callers can retry deliberately and the first consumer only needs one candidate-choice workflow.

## Consequences

Jev is available to future consumers through one small capability while the normal LLM route and replay contracts stay stable. The Models page owns dropdown selection and lifecycle, while the Jev card owns only its credential write. The decision tool can abstain, so missing optional infrastructure preserves the existing agent path. The provider's direct `fetch` keeps the dependency closure small, but the API response validator must track the TypeSafe wire fields used by consumers.

## Testing

The new Host and consumer packages compile in the Host aggregate, the UI contribution compiles in the Client aggregate, and existing Models component/form suites continue to pass with the optional slot absent. The focused provider and browser-consumer tests cover successful response projection and missing-service abstention; live provider calls remain opt-in.
