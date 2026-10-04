# Agent Note: Session-local prompt versions

Status: implemented

## Problem

Prompt editing needs preserved answers, reproducible model input, and references between versions. Independent cloned sessions duplicate prefixes, separate context caches, and hide storage objects behind one conversation row.

## Decision

A session keeps one append-only log with globally contiguous event sequences. `session/version` names a new version, its parent, and the excluded prefix cutoff; `session/version-selected` selects an existing version. Both are mandatory core log events. The incremental version index stores linked immutable event references, sharing prefixes and caching only the selected transcript array. It rejects unknown parents, duplicate IDs, and cutoffs outside the parent path before commit.

`Session.events` retains the complete log for persistence, actual usage totals, and sequence citations. `Session.activeEvents`, model-message derivation, request headers, runtime context, inbox replay, plan/todo projections, token pressure, and compaction use the selected path. Selection increments a generation that invalidates request and token caches. Active-version projection units rebuild on path changes; cold checkpoint restoration requests the complete log when a suffix contains a path change. Actual usage remains cumulative across versions and starts a new sample identity on each path change.

The loop vetoes a version change during active work through synchronous `session/version-changing`, then restores its turn counter and request anchor after commit. The Host serializes prompt, model, and version admission per Agent, validates retained images, cancels and drains replacement work, and parks the exact new prompt before durability acknowledgement. Retry receipts use a deterministic version ID and survive restart. No editing path creates another Session, Agent, or Workspace attachment.

The UI selects or references a stored version. Selection restores its complete transcript without generating; reference queues a bounded, logged recall for the next prompt. `session_version_list` and `session_version_read` let the model inspect the same session on demand. Reads preserve event sequence citations and use bounded UTF-8 pages with continuation offsets. Other versions do not enter requests automatically.

## Alternatives considered

**Clone one session per edit.** This duplicates shared prefixes and gives one conversation several storage and cache identities. **Inject every version into context.** This increases request size and mixes mutually exclusive prompt histories. The version index retains complete history while model input follows one selected path and explicit references.

## Consequences

Tool effects remain external state; selecting old text does not revert files. Prefix identity and durable replay are testable independently of the UI. Branch-local context estimates and whole-session usage report different quantities deliberately. Compaction uses the session's construction boundary to clear inherited locks even when the selected path does not contain the latest resume marker. The assembled Web flow covers same-session admission, preserved prefixes, navigation, references, restart, cancellation, and SQLite persistence.
