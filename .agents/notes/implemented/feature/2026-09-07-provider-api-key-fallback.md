# Agent Note: Ordered provider API keys

Status: implemented

## Problem

A provider with one rejected or unavailable credential cannot complete requests even when the user has another key for the same endpoint. Retrying after partial streaming must preserve history and avoid duplicate tool execution.

## Decision

DeepSeek and pi-ai profiles use a primary `apiKeyEnv` and ordered `apiKeyFallbackEnvs`. The Models editor and custom-provider card store values through credentials and write only references into settings. Fallback references contain a provider prefix and UUID, avoiding collisions between independent drafts. Blank existing fields preserve values; acknowledged writes clear only their own drafts. Removal unlinks references and deletes only writable credentials owned by this page.

`streamWithApiKeys()` shares key positions with `llm-retry` through an asynchronous request scope. The plugin owns one position per agent, open step, provider, and model. It advances after any failed attempt except caller cancellation, including missing credentials and authentication failures, and logs existing retry events with a separate finite fallback policy. All keys are tried once; ordinary retry policy then applies to the final key. New steps begin at the first key. Auxiliary calls clear inherited conversation selection and buffer their multiple-key attempts.

## Consequences

Agent recovery creates fresh assembly per attempt, leaves failed chunks in the event log, excludes them from model history, and executes tools only after a successful response. Reusing it preserves streaming without reset chunks or concatenated responses. Direct consumers have no reset operation, so multiple-key direct calls expose a single buffered response. No key or reference is model-visible; no stream, session-event, or SDK payload changes.

This extends [bounded request recovery](../architecture/2026-06-21-bounded-llm-request-recovery.md) and [per-provider policies](2026-07-24-provider-retry-policies.md); both remain active for failure classification, durable recovery, backoff, and policy ownership. Neither is wholly superseded.

## Alternatives considered

- A global rotating index lets concurrent conversations consume each other's keys.
- Transport retries after partial output assemble content from different attempts.
- Buffering conversation output delays streaming until the whole response completes.

## Verification

Package regressions cover HTTP authentication failure, partial-stream disconnect, SDK error finishes, missing credentials, concurrent agents, cancellation, finite exhaustion, tool side effects, and partial credential-save retry. The headless example snapshots a streamed failure, fallback, and ordinary retry over unchanged model history. The Web scenario saves multiple keys through the shipped composition, checks write-only reload and reference-only settings, and snapshots the editor.
