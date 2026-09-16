# Agent Note: Session-local model call diagnostics

Status: implemented

## Problem

A changed request header identifies the selected model, but unchanged headers do not identify every call. Step-level timing conflates adapter setup with the wait for output, and auxiliary title or compaction calls need their own attribution. Diagnosing a slow exported session requires matching each model attempt to its output and requested tools without reconstructing ownership from nearby events.

## Decision

The [llm-call-log plugin](../../../../packages/llm/llm-call-log/README.md) observes the existing `llm/stream` waterfall and records start, first meaningful output, and completion in the session named by `GenerateOptions.sessionId`. Start sequence numbers correlate records within each session; provider and model are repeated on output and completion for direct inspection. Purpose distinguishes loop requests, declared auxiliary work, and unclassified one-shots. Complete model tool calls carry the existing tool call ids, preserving the executor's authority over dispatch and results.

These are observations, not another response controller. The [bounded recovery decision](../architecture/2026-06-21-bounded-llm-request-recovery.md) continues to own retries, discarded output, and successful message commitment. The [telemetry capture coordinator](../../../../packages/session/session-telemetry/README.md) can export these canonical events without owning their production. Both decisions remain active because they govern independent behavior.

Timing starts at stream consumption and uses a monotonic clock. First output and first visible text are separate measurements. Diagnostic records omit prompt text, tool arguments, provider bodies, and credential values; those records add no model-visible tokens. The base bundle mounts the observer, and removing its fiber prevents new observation while active streams finish their existing records.

## Alternatives considered

**Infer everything from step boundaries and request headers.** These records remain useful for older logs but cannot identify overlapping auxiliary calls or separate the first reasoning delta from the first visible text of each attempt.

**Add provider-specific HTTP tracing first.** Provider hooks can expose refresh, endpoint fallback, and network timing, but do not replace provider-neutral attribution. The common observer reports only timings it actually measures and leaves HTTP sub-attempts explicitly unmeasured.

**Put logging in the loop or retry policy.** Auxiliary calls bypass the loop, and diagnostics must remain available without changing retry policy. A separate observer preserves both extension points.

## Consequences

Each model stream adds at most three small records. Calls without a live session id have no session attribution, and a crash can leave an unmatched start. A closed stream does not imply model success. Tool call/result intervals retain approval, scheduling, and ordered publication time rather than claiming pure execution duration. Older exported logs cannot gain missing measurements.

The focused checks cover concurrent routes, reasoning versus text, incomplete tool calls, failures, cancellation, unchanged chunks and history, disposal, and invalid record correlation. The headless runnable-example snapshot covers a model/tool/model round trip through the real Loader, loop, persistence, and CLI output.
