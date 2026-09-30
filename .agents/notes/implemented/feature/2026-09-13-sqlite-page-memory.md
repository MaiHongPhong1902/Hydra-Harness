# Agent Note: Private SQLite page memory with live Browser verification

Status: implemented

## Problem

An agent that repeats work on the same web application needs durable instructions for the current page and task, but the full DOM and snapshot references are too large and transient to keep in context. A page-memory feature also needs to distinguish reusable procedure from current business data and must not turn website text into authority.

## Decision

`@hydraharness/harness-page-memory` stores one bounded set of task workflows per page in a private `page-memory.sqlite` database. The database lives below a hashed directory under the user's Hydra home, or an explicit absolute `storageDir`, and uses a namespace made from the canonical workspace path plus configured role and locale. `pageKey()` preserves the complete query and fragment; optional route rules use explicit complete `:name` path segments to share procedures across dynamic path values without merging distinct query or fragment views. Schema version 3 retains bounded verification observations with outcomes and durations for offline replay and assigns each task a monotonic revision; older schemas are rejected instead of migrated silently.

The plugin exposes `page_memory_get` and `page_memory_upsert`. `page_memory_get` selects one exact stable task for the turn; without a selection it lists tasks for the current page. Lookup has no cross-page or cross-namespace fallback. `page_memory_upsert` replaces the selected task only after a successful Browser action in the same task, turn, tab, and current URL, a live success check, and verification of all saved anchors and CSS selectors. A workflow ending on another page may supply `sourceUrl` only when targeted, complete source snapshots precede the successful action in that same task, turn, and tab. SQLite writes are transactional and enforce complete-record, workflow-count, page-count, and history limits. Recall records compare the inspected workflow inside the write transaction before changing stale status, so a concurrent replacement remains verified.

Automatic recall runs at `agent/pre-step` and appends bounded guidance when it differs from the latest automatic recall or successful `page_memory_get` result on the active context. Model-facing guidance omits host revision and verification time while retaining procedure, task, status, and stale diagnostics. Compaction can trigger reinjection. The action guard requires matching guidance to have appeared in an agent-loop model request and remain on the active context; appending a tool result within the same batch does not satisfy that requirement. Navigation, tab lifecycle, and observation tools remain available for recovery. Parser checks reject control characters, executable URLs, obvious secrets, and transient Browser references; the prompt restricts content to reusable procedures and excludes credentials, cookies, tokens, raw DOM, and task-specific values.

Verification reads each unique selector once per pass on the same page and tab and tests every associated expectation against that observation. No Browser data is reused across passes. The final identity check rejects a changed URL, tab, or unsettled page, but does not make the DOM observations atomic. Empty content and text mismatches mark the workflow stale with a persisted, bounded selector diagnostic; timeouts and Browser failures leave stored status unchanged. Saves still verify the outcome after the action, and compare-and-record retains the complete stored workflow revision for concurrent replacement checks.

This decision is scoped to page memory. The [Obsidian knowledge independence decision](../architecture/2026-09-10-obsidian-knowledge-independent-of-browser.md) remains in force: `obsidian-knowledge` has no Browser dependency and page memory does not write to or observe Obsidian.

Background metadata reads preserve manual navigation and do not open approval dialogs under the Browsing `ask` policy. In that mode, pre-step recall can project a successful, still-visible `page_memory_get` result from the current turn. The action guard separately verifies the current page through Browser approval, so an earlier explicit read does not authorize a later action. Browsing approval covers the reads within one active logged tool call and names that requested tool; completed calls and reused model call ids require a fresh decision.

## Alternatives considered

**Reuse Obsidian knowledge.** Rejected because page memory needs exact page and task replacement with live Browser checks, while Obsidian owns an independent graph/MCP capability and would reintroduce the coupling that decision removes.

**Scatter JSON files by page.** Rejected because one SQLite file per namespace gives transactional replacement, bounded counting, schema ownership, and a single private storage lifecycle without inventing file locking and multi-record update rules.

**Add a vector database.** Rejected because exact page/task keys cover the current workflow and a vector index would add another dependency, index lifecycle, and migration without measured retrieval evidence.

**Persist the full DOM or snapshot references.** Rejected because DOM output consumes context and snapshot refs are document-local and expire; targeted anchor text and CSS selectors can be rechecked against the live page.

**Cache Browser observations across verification passes.** Rejected because manual navigation and page changes require fresh checks. Per-pass selector reuse removes duplicate calls without a TTL or invalidation mechanism.

**History scans versus an incremental guidance index.** The [context projection decision](../simplification/2026-09-30-page-memory-context-projection.md) owns this trade-off. The projection follows committed events, catches seeded or missed events up before reads, and rebuilds after positional context replacement; the guard retains the actual-request requirement.

## Consequences

Workflows may include an optional `accountHint` describing a suitable account type. This guidance is subject to the workflow's size and secret checks, is recalled as untrusted prose, and does not identify a login, partition storage, or grant permissions.

The agent gets durable, compact procedure recall outside the normal prompt context, while current values and authorization stay in live Browser reads and existing policy checks. Stale status supersedes earlier instructions; continuing work then requires the model to use current observations. Query and fragment distinctions prevent route records from merging screens that only look similar by pathname. Token savings on real applications remain unmeasured.

The feature requires an explicit host workspace, role, and locale, and it supports exact task names and CSS selectors only. Runtime verification does not prove the meaning of prose steps or classify arbitrary personal data; local SQLite is personal storage without shared-tenancy ACLs, and semantic/vector retrieval is absent.

## Testing

The package tests exercise durable SQLite writes, concurrent initialization, schema rejection, bounded records and history retention, compare-and-record replacement safety, exact task selection, compaction reinjection, transient-read recovery, task-bound action evidence, source-observation ordering, and explicit-read fallback when background browsing needs approval. They also cover metadata-only saves, procedure changes, same-batch tool results, request omission, auxiliary requests, persisted stale diagnostics, and repeated selectors with distinct expectations. The [runnable ACP scenario](../../../../examples/acp-agent/page-memory.cordis.yml) pins learning and recall through the Loader, real Browser service and tools, and SQLite with replayed model and Electron inputs. The replay tests and CLI use that real session log, preserve the baseline, and keep incomplete outcomes unknown. Native Browser tests cover live tab identity and preservation of manual navigation. Full desktop smoke and measured real-site token savings remain unverified.
