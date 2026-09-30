# Agent Note: Incremental page-memory context visibility

Status: implemented

## Problem

Page-memory recall needs the current turn and the latest retained automatic or explicit guidance. Browser action guards also need to know whether guidance included in a model request remains in context. Repeated reverse scans and derived-message copies make this work grow with history even when no relevant guidance changes. A representative Browser workload has not established that these scans dominate task latency.

## Decision

The [page-memory context projection](../../../../packages/knowledge/page-memory/src/context.ts) follows committed `session/event` notifications. Each plugin instance owns a weak map keyed by the exact Session object. The projection tracks the latest turn, latest active guidance, current-turn explicit reads, retained guidance message identities, and pending tool-call provenance. It keeps no copy of the complete log and no Browser observations.

Reads synchronously catch up to the current log sequence, including constructor seeds that publish no notifications. Known appends update the projection directly. Context replacement generations or results citing calls outside the pending batch trigger a rebuild from the authoritative active context. Rebuilds preserve positional context order rather than assuming that the greatest event sequence is the latest visible guidance. Successful `page_memory_get` results require a cited matching tool call; failed or unrelated results do not become guidance.

The existing `llm/stream` check still requires guidance in the actual agent-loop request. The action guard checks the exact requested message against retained identities; identical text in a different message does not prove that the requested message survived compaction. Auxiliary requests and same-batch tool results do not authorize actions. The Session-owned record also owns agent-specific task and requested-guidance state, so disposal releases it even when the agent has already left the registry. Same-id replacement Sessions receive independent state; plugin listeners remain Cordis-owned effects.

This decision supersedes the history-scan choice in the [SQLite page-memory decision](../feature/2026-09-13-sqlite-page-memory.md), which continues to own storage, live verification, concurrent workflow revision checks, and authorization. The loop, session event schemas, SQLite format, model-visible text, and Browser checks remain unchanged. The [user guide](../../../../docs/user/guide/page-memory.md) describes the resulting behavior without treating retained guidance as current page data.

## Alternatives considered

**Keep authoritative scans until a real workload proves a bottleneck.** This avoids projection state and remains reasonable when startup or replacement costs dominate. The implemented optimization targets repeated host work; it does not establish a task-latency bottleneck or real-site savings.

**Reverse indexing without copied arrays.** This removes allocation while retaining linear lookup through unrelated history. Event updates also remove repeated lookup and derived-message membership copies; bootstrap and replacement still use authoritative scans.

**Add a generic cache service or persist the projection.** Rejected because this state belongs to one plugin and one live Session. The existing log and context already supply durable reconstruction, replacement generations, and lifecycle notifications.

**Reuse Browser data across verification passes.** Rejected because manual navigation, loading, and DOM changes require fresh checks. Per-pass selector reuse remains the only Browser observation reuse.

**Use provider cache-hit rate as the index acceptance target.** Rejected because equivalent model requests preserve cache eligibility. Provider routing and retention remain external variables.

## Consequences

Ordinary event updates and repeated visibility reads avoid whole-history scans and array copies. Projection storage is proportional to retained guidance references and pending calls, with pending calls cleared at step completion. Cold bootstrap scans the log and context, and replacements rebuild active guidance; these costs can exceed one isolated baseline lookup. Event tracking adds per-event work and lifecycle state.

The isolated host benchmark compares append, turn lookup, guidance lookup, and requested-message membership on short and synthetic long contexts. It separates fixture construction and bootstrap from repeated queries. Those measurements establish the operation's cost, not Browser task speed, model quality, token savings, or API cost. Real-site input tokens, cost per successful task, and latency remain unverified against a baseline.

## Verification

Projection tests compare current-turn and guidance results with the authoritative scan after appends, gaps, duplicate notifications, seed restoration, partial and repeated replacements, and tool-result rewrites. They assert no log snapshot reads on repeated live-event queries. Integration tests cover actual event dispatch, exact requested-message removal with identical guidance retained, disposal, same-id Session replacement, and disk restoration without implying model visibility. Existing tests retain request omission, auxiliary requests, same-batch results, navigation, concurrent workflow replacement, and live-check behavior.

The [runnable ACP composition](../../../../examples/acp-agent/page-memory.cordis.yml) keeps the real Loader, Browser service and tools, and SQLite while replaying model and Electron inputs. Its complete expected transcript remains the regression check for request and guidance equivalence. No SDK snapshot update is required because the loop, session lifecycle, and event vocabulary do not change.

## Deferred real-site measurement

A comparative Wiki workload needs calibrated tasks and successful answers checked against captured live observations: article introduction, named facts in a specified section, and linked-article comparison. The report records exact URLs, page revisions, task wording, model and provider route, runtime configuration, and build identity. A bounded availability pilot precedes expansion; saved provider metadata alone does not prove deployment availability. Failed and unavailable attempts remain in the evidence.

Empty local storage and verified saved procedures use the same exact page/task keys and fresh sessions; repeated turns measure history growth separately. Neither condition proves a cold or warm provider prompt cache. Long-session, compaction, resume, manual-navigation, stale-selector, and concurrent replacement cases remain necessary for representative comparisons. Provider cache variation and instrumentation overhead limit small-sample conclusions.

Native `llm/call-start` and `llm/call-end` records include retries and auxiliary requests, reconciled against observed stream requests. Uncached input, cache-read input, cache-write input, output, first-output latency, elapsed time, and missing usage are reported separately; assistant-message usage is not added again. Cache-read share is `R / (U + R + W)` only for known counters with explicit coverage. Initialized error zeros do not prove zero billing, reasoning included in output is not charged twice, and costs require dated route-specific rates and currency. Gateway placeholder zero prices remain unknown cost.

The [PageAgent bridge](../../../../packages/browser/browser-electron/src/page-agent-llm.ts) can make auxiliary requests without `sessionId`, which the [native call logger](../../../../packages/llm/llm-call-log/src/index.ts) skips. Controlled native-Browser measurements exclude that engine or meter it separately. Request, output-token, and elapsed-time limits bound each pilot, partial evidence is persisted, and repeated failed lookups terminate the run.

Host measurements separate projection bootstrap, event updates, queries, replacement rebuilds, allocation/GC, SQLite, Browser waits, and model latency. Browser content reads and identity reads are counted at the service, not equated with physical DOM accesses. Scan cost reaching 5% of host CPU and 5 ms per-step p95, or attributable material GC pauses, remains an investigation threshold rather than a measured property or a prerequisite met by this implementation. Stopping-policy replay preserves the observed baseline and chronological holdout; no unobserved alternative outcome is inferred. Task success, sample counts, missing coverage, and host-only synthetic results remain distinct from real API savings.
