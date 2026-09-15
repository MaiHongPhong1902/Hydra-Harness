# Agent Note: An account profile's model list is an override, not a requirement

Status: implemented

## Problem

A ChatGPT or Antigravity account profile is saved from the Models page without a model list: the editor materializes an empty profile and expects the catalog to come from the route itself — the adapter's own models, or what the account discovers — or from the page's "Fetch available models" action. The settings schema materializes `[]` for the absent key, and `resolveProfiles` refused an empty list with `provider "<route>" has no models`.

Because `apply()` resolves the profiles eagerly, that refusal failed the whole `llm-account-auth` plugin rather than the one route. Its settings section was never installed, so the browser's settings mirror carried no `llm-account-auth` namespace, and the Models page renders the account editor only when that namespace resolves. The visible symptom was a dead entry point: with such a profile already in `settings.yaml`, clicking "Add sign-in provider" did nothing at all. The same message rejected every Apply that would have created a profile, so the state could not be escaped from the page either.

## Decision

`resolveProfiles` reads an absent list and an empty one as the same request — this route serves its live catalog — and stores the profile with the key detached. Only a non-empty list replaces the catalog. No model list has to be written into configuration for a sign-in route to work, and a profile that is only a saved route plus its optional endpoint is a valid document.

The key is detached rather than stored empty because both adapters read `profile.models !== undefined` as an explicit override: Antigravity would serve an empty catalog instead of discovering one, and the ChatGPT profile builder would replace its installed catalog with nothing.

This mirrors the decision `resolveRouteModels` already records for pi-ai routes, where an empty `models` and an absent one both mean "serve the installed catalog".

## Alternatives considered

**Keep refusing an empty list, and make the editor stop writing one.** Rejected because the schema materializes `[]` for an absent key: the document the editor saves cannot express "no override", so the refusal returns on the next apply.

**Keep `[]` meaning an explicitly empty catalog, and teach each adapter to tolerate it.** Rejected as more surface for one rule — the account adapters and their catalog builders would each need the same escape, and the two readings would still be indistinguishable in the stored document.

**Require a fetched catalog before the profile may be saved.** Rejected because it makes saving a route depend on reaching the provider: a dormant route is legitimate, and sign-in is what makes a route worth adding.

## Consequences

A saved account profile is no longer a configuration error, so the entry point renders and the sign-in flow runs on a document that stores one. Switching an existing customized catalog back to the route's own models is now expressed by emptying the list, and a deliberately empty catalog — a route that serves nothing — is no longer expressible for account routes. Model availability for these providers belongs to the adapter or the authenticated account and changes independently of a release, which is the same reason the Antigravity route discovers its catalog rather than pinning a copy.

## Testing

`packages/llm/llm-account-auth/tests/loader-composition.spec.ts` rewrites the settings document from a listed catalog to a profile with no `models` key and then to one with `models: []`, asserting through the Loader that each leaves the route serving its own catalog rather than the previous list or nothing. The same document failed the apply with `has no models` before this change.
