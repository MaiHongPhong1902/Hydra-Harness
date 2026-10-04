# Agent Note: Shared Google model discovery

Status: implemented

## Problem

The shared Google login serves two backends. Separate Fetch actions obscure which catalog is being queried, and merging equal model ids would route selections to the wrong backend.

## Decision

When both Antigravity and Gemini API are configured, the Google account editor has one Fetch and one Get all action for them. Discovery calls both existing Host routes concurrently and presents service groups in one picker. With only one configured service, discovery queries that service alone and Apply never creates the other service. Selection, editable names, and image/video flags use a catalog/model pair. Adoption updates each service's draft independently; an existing row keeps its tuned metadata unless classification is explicitly edited.

Both catalogs remain visible for review. Apply writes their model changes in one revision-checked settings mutation and preserves unrelated profile fields. Canceling the picker or editor saves no model changes. A failed backend is named in the picker while the other backend's results remain usable; two failures leave the drafts intact. Antigravity discovery reads its account catalog even when conversation settings contain a model override. Conversation catalog queries continue to honor that override.

The [shared OAuth decision](../architecture/2026-10-03-shared-google-oauth-routes.md) owns credentials, account removal, projects, and transport routing. No combined Host provider or cross-backend inference is introduced.

## Alternatives considered

**Merge by model id.** Rejected because the same id can use different transports, account quotas, and generation capabilities.

**Persist during Fetch.** Rejected because fetched selections must remain reviewable and discardable until Apply.

## Consequences

Source tests exercise both entry services, duplicate ids, editable classification, partial and complete failures, cancellation, reset, invalid sibling rows, and rejected writes. The assembled keyless Web scenario covers authenticated discovery with both project headers, selection, atomic persistence, reload, and grouped output. External Google account acceptance and entitlement require live verification.
