# Agent Note: Browser evidence and unfinished result reporting

Status: implemented

## Problem

The browser evaluation distinguishes known answers from actions actually completed on a rendered page. Incorrect expressions, control types, and unverified modes can produce false completion claims. A page read can fail after an action reports success; merging these outcomes encourages duplicate actions. A three-state todo list lacks a truthful outcome for blocked, failed, or cancelled work. Invalid JSON escapes make an otherwise useful result unreadable.

## Decision

The [browser service](../../../../packages/browser/browser-electron/README.md) preserves an acknowledged action when its trailing observation fails. `observationError` accompanies live native metadata, empty page contents, and `settled:false`; it never converts an unacknowledged action into success. Explicit read failures, cancellation, metadata transport failures, and action request failures remain errors. The model must read state before retrying an action with an unknown effect.

[Browser guidance](../../../../packages/browser/tool-browser/src/prompt.ts) requires observed operation, parameters, mode, and output before completion; real labels and options before form actions; changed observation after failed attempts; and exact field values, navigation provenance, and capture timestamps. Model claims remain semantic judgments rather than mechanically validated facts.

Instructions stay with their owning tools: browser evidence in browser guidance, task lifecycle in `todo_write`, and deliverable consistency in `write`. JSON parsing and schema validation run in code; observation failures carry recovery advice in the failing result. These checks need no repeated explanation in the standing prompt.

The model-facing text exposes capture timestamps, distinguishing snapshots from native metadata after omitted or failed page reads. Canonical output fields alone do not provide evidence when only rendered text enters model history.

The [todo tool](../../../../packages/todo/tool-todo/README.md) records `blocked`, `failed`, and `cancelled` separately from `completed`, including in durable invariants, projections, counts, and UI labels. Projection version 3 invalidates older cached views. Whole-list replacement and single-session ownership remain as specified in the [todo decision](../feature/2026-06-29-todo-write-tool.md); this note owns the expanded lifecycle. Reasons belong in the existing content field.

The [write tool](../../../../packages/fs/tool-fs/README.md) parses and serializes JSON before filesystem mutation and checks an optional task-supplied schema through the existing tools validator. Unsupported schema keywords fail loud. `format:text` permits literal coding fixtures, while result deliverables use JSON validation. Read-back and semantic agreement between answers, observations, status, and blockers remain required model guidance.

## Alternatives considered

**Treat any timeout as a failed action.** A successfully acknowledged action may already have changed the page. Observation failures do not determine its outcome.

**Infer browser success from the correct answer.** Mathematical knowledge and a successful click do not prove the requested input or result appeared on the website.

**Infer a result schema from a filename.** Arbitrary JSON files have different fields and semantics. Callers supply the task schema; syntax and finite JSON values are checked independently.

**Add a new result writer and task service.** Existing write execution, schema validation, session events, and projection ownership already provide the required mechanisms.

## Consequences

Prompt and schema changes are model-visible and require assembled replay. JSON validation protects write calls; explicit text writes, edits, shell writes, and unsupported result schemas do not acquire automatic validation. A valid JSON file can still contain an incorrect answer. Fresh native metadata is page identity, not evidence of a completed calculation or selected mode. These changes do not identify the original preload failure or establish improvement across the 214 live tasks without rerunning that evaluation.

The [browser completion note](2026-09-13-browser-action-completion.md) and [selective observations note](../feature/2026-09-13-browser-selective-output.md) remain active for cancellation, ref validity, and hidden-baseline guarantees.
