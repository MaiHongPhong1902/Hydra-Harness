# Agent Note: Shared Google OAuth for Antigravity and Gemini API

Status: implemented

## Problem

Two Google sign-in flows would require duplicate consent and independent copies of a refresh grant. Antigravity's Code Assist project also cannot stand in for a Gemini Developer API quota project.

## Decision

Antigravity and `gemini-api` share one Host account pool, authorization flow, request-local selection context, and credential modifier. The existing `llm-account-auth/antigravity` record key remains the pool owner. Its default `oauth` method opens Antigravity PKCE login immediately without requiring a user-supplied Cloud project. The `gemini-api` method uses the same OAuth implementation and `cloud-platform` scope, then asks for the API quota project and checks Gemini `models.list` before storing the account. Project requirements belong to the service requesting API quota; they cannot block Antigravity login. A rejected project or canceled attempt leaves existing accounts unchanged.

The shared grant retains `projectId` for Cloud Code Assist and `quotaProjectId` for Gemini's `x-goog-user-project` header. Both adapters and account usage refresh through the client that issued the Antigravity grant, preserving both projects and account identity. Credential updates invalidate both route catalogs. Removing an account removes its access from both routes. Antigravity usage remains identified as Antigravity usage; API quota is unavailable in that account display.

Settings offers one Google option for Antigravity. New Gemini API connections use the [custom-provider API-key template](../feature/2026-10-03-gemini-api-custom-provider.md). Saved OAuth API profiles remain editable under API keys. The selected service determines the login method, and Apply enables only that service. Configured Antigravity/Gemini API OAuth counterparts retain the [shared discovery picker](../feature/2026-10-03-shared-google-model-discovery.md); an absent counterpart is neither queried nor created. Catalogs and request routing remain separate. Gemini API OAuth conversations use Google's OpenAI-compatible protocol through pi-ai; its image generation uses native `generateContent`. Model discovery preserves unnamed models and endpoint metadata. Imagen and video submission are refused on the OAuth API adapter before generation work.

The sign-in link appears as the primary action beside Add account and Cancel sign-in. Provider instructions remain below those actions so lengthy instructions cannot push the link behind the form's input fields.

## Alternatives considered

**Separate Google grants.** Rejected because they cannot provide one sign-in and one refresh owner.

**A second Desktop OAuth implementation.** Rejected because the existing Google flow already requests the required scope and owns callback validation, PKCE, cancellation, and token refresh.

**Combine both catalogs into one provider.** Rejected because equal model ids can identify different transports and quota sources.

## Consequences

Existing Antigravity accounts remain accessible. They need reconnection with an API quota project before Gemini API requests can use them. A fixture proves shared grant storage, concurrent refresh, bearer/project headers, native image requests, and assembled Web selection, Apply, Fetch, and shared logout. Fixtures establish wiring; Google's acceptance of this OAuth client's grant, account entitlement, Cloud IAM, billing, and native Electron interaction require separate live verification. Gemini's general OAuth support is documented in the [official OAuth guide](https://ai.google.dev/gemini-api/docs/oauth).
