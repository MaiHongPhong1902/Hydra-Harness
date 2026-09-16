# @hydra/harness-llm-call-log

Records model calls in the owning session through the `llm/stream` waterfall. The base bundle mounts this observer for Web and headless profiles. Each consumed stream records its provider, model, purpose, input message count, system-prompt character count, and advertised tool names. Conversation records also identify the turn and step. Auxiliary calls retain their explicit `session-title` or `compaction` purpose; other one-shots are `auxiliary`.

## Reading the log

`llm/call-start` marks stream consumption, `llm/call-first-output` marks the first non-empty text, reasoning, or tool-call delta, and `llm/call-end` records the outcome, elapsed milliseconds, first-output and first-text times when observed, token usage when supplied, and complete tool calls requested by the model. Output and end records carry `callSeq`, the start record's sequence within that session, plus provider and model. Each retry through the waterfall has a separate start sequence.

Match each end record's `toolCalls[].callId` with existing `tool/call` and `tool/result` events to inspect arguments, results, and elapsed time until the result is committed. Requested tools do not imply execution or success. `tools` in the start record lists available tools, not invocations.

Timing uses a monotonic clock and begins when the stream is consumed, before adapter setup. `firstTextMs` distinguishes visible text from earlier reasoning. An unfinished stream is `closed`, cancellation is `aborted`, and thrown middleware errors are `exception`; provider finish reasons remain intact. A crash can leave a start without an end. Disposal removes the observer for new calls; already-consumed calls finish their records while their session remains live.

These diagnostic events survive normal session persistence/export and never enter model history. Prompt text, tool arguments, provider response bodies, and credentials are not copied into them. The invariant companion checks start references, route identity, duplicate completions, and timing consistency. Rationale: [model-call diagnostics](../../../.agents/notes/implemented/feature/2026-09-16-model-call-diagnostics.md).

## Model Experience

None, as this observer records diagnostics without changing model requests or stream chunks.

#### KV Cache effect

None; model-visible messages, tools, and prompts are unchanged.

## Known Limitations and Deferred Work

- Calls without a live `sessionId` pass through without session diagnostics.
- Timings cover adapter setup and the consumed stream, not individual HTTP attempts. OAuth refresh, account rotation, endpoint fallback, and network first-byte timing require provider-specific instrumentation.
- Existing logs are not backfilled. Tool call/result intervals include approval, scheduling, and ordered result publication; they are not pure execution time.
