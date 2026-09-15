# Agent Note: Antigravity tool responses use user turns

Status: implemented

## Problem

Cloud Code Assist accepts an assistant function call but rejects the following request when its function response is encoded in a model content turn. The resulting generic HTTP 400 appears after a tool has run, even though a direct text request and the initial tool declaration succeed.

## Decision

The Antigravity serializer emits every function response in a `role: "user"` content entry, matching the Gemini function-calling wire format. The active machine profile does not pin an Antigravity model catalog, so the account adapter discovers the current catalog instead of relying on a copied list that can drift from account entitlement.

## Alternatives considered

**Keep function responses as model turns.** Rejected because Cloud Code Assist validates the content role for function responses and returns HTTP 400 on tool continuations.

**Retry a failed request with a different role or model.** Rejected because retrying after a provider validation failure hides malformed request construction and can execute a tool continuation more than once.

**Maintain a larger hardcoded Antigravity model list.** Rejected because model availability belongs to the authenticated account's live catalog and changes independently of the application release.

## Consequences

Tool continuations use the provider's accepted role and remain deterministic across retries and account rotation. Antigravity model discovery now reflects the connected account after the local override is removed; deployments may still provide an explicit catalog when they intentionally need an offline or curated route.
