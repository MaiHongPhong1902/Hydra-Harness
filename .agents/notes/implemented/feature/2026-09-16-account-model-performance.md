# Agent Note: Account route model request performance

Status: implemented

## Problem

Account-backed model calls need the same request-policy scrutiny as API-key routes. A short user prompt does not imply a small request: the system prompt, tool catalog, auxiliary title generation, account selection, and provider defaults all contribute to latency. In the investigated Antigravity session, first output took about 24–28 seconds and the title exhausted its output cap largely on reasoning. These observations establish slow model calls, not OAuth as their cause.

## Decision

The [account adapter](../../../../packages/llm/llm-account-auth/README.md) passes ChatGPT reasoning, cache retention, transport, SDK timeout, WebSocket connect timeout, and retry settings to pi-ai. For `session-title`, pi-ai selects the exact model's advertised `off` or `minimal` mode; Codex requests use explicit `reasoningEffort: 'none'` and `reasoningSummary: 'off'` when `off` is advertised. Conversation and compaction retain their own defaults. Antigravity title requests omit `thinkingConfig`; omission alone does not prove that the provider disables thinking.

Antigravity SSE reads use the shared idle watchdog. `streamIdleTimeoutMs` must reach the native transport through both adapter layers; declaring the setting or passing it to only the outer adapter does not establish that it is effective. Account retry policy uses the existing [provider recovery policy](../architecture/2026-06-21-bounded-llm-request-recovery.md).

Account selection, failover before visible output, replay stripping, and credential isolation remain required. DeepSeek supplies a behavioral reference, not wire fields to copy across providers. The [session-title decision](2026-07-21-log-backed-session-titles.md) still owns title cadence, fallback, and cancellation; the [model-call diagnostics decision](2026-09-16-model-call-diagnostics.md) owns call attribution. Neither decision is superseded.

## Verification

- Latency evidence correlates `llm/call-start`, `llm/call-first-output`, and `llm/call-end` by `callSeq`, provider, model, and purpose. First reasoning and first visible text are separate measurements. Tool duration comes from matching tool call/result ids; overlapping title and conversation calls are measured separately.
- A request-control change requires a non-default value checked at the final provider option or request body. A schema declaration or intermediate profile assertion alone cannot prove propagation. Unsupported controls must not silently look effective.
- Title coverage distinguishes conversation, compaction, and title requests on the same route. Reasoning omission, hidden thoughts, and explicitly disabled thinking are distinct provider behaviors; reducing visible reasoning is not evidence of lower reasoning usage.
- Timeout coverage checks the adapter entry point, cancellation of the underlying reader, caller abort versus local `TIMEOUT`, and consumer pauses. Header wait, credential refresh, and body-read idle time are separate intervals.
- The focused regressions live in the [Antigravity adapter tests](../../../../packages/llm/llm-account-auth/tests/antigravity.spec.ts), [ChatGPT profile tests](../../../../packages/llm/llm-account-auth/tests/chatgpt.spec.ts), and [pi-ai adapter tests](../../../../packages/llm/llm-pi-ai/tests/adapter.spec.ts). A provider spy verifies SDK options, not the final wire protocol. Assembled account-route snapshots and live provider timing remain separate evidence requirements.

## Alternatives considered

**Disable reasoning for every account request:** rejected because reasoning is part of normal conversation behavior and user configuration.

**Add a second account-specific retry or transport implementation:** rejected because pi-ai already owns those controls and the shared timeout primitive covers native SSE reads.

## Consequences

The implementation shares provider policy and timeout machinery without changing the ReAct loop. A stalled Antigravity body read returns `TIMEOUT`; its watchdog begins after response headers and does not cover credential refresh or the initial HTTP wait. Account-route Loader snapshot coverage, live Antigravity thinking behavior, and before/after latency remain unverified. Passing unit tests or adding a config field does not establish that the reported 24–28 second delay is resolved.
