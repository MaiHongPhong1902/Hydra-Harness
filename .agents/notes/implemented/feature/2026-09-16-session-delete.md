# Agent Note: Permanent Session deletion

Status: implemented

## Problem

The Session row menu exposed Delete as a visual-only action, while Archive provided the only shipped way to remove a conversation from browsing surfaces. Archive intentionally retains the Session log, Workspace account, and derived sidecars, so it cannot satisfy a user request to remove retained data. A durable implementation also has to handle conversation prompt revisions and descendant subagent logs, reject races with live Agent work, remove Workspace and archive references, and tell derived stores that a log is gone rather than merely detached.

## Decision

`SessionPersistence.delete(id)` permanently removes one stored log or zero-event reservation. Missing ids are successful no-ops, deletion joins the id's serialized write chain after any retirement, and a live owner, write handle, or unpublished preparation rejects. The JSONL and SQLite providers implement the operation against their independent physical storage.

The Host exposes `session.delete`. It resolves the selected conversation's revisions and transitive subagent descendants, rejects direct subagent deletion, and rejects a running or externally owned Session while leaving the rest of the cascade unmodified. A per-id deletion fence blocks resume and create races. Before disposing Host-owned Agent handles, the Host drains their continuable descendants so child handles release in lifecycle order. Descendant logs are removed before the requested identity, and each successful log removal also removes the id from Workspace accounts and the global archive set. The response returns the complete affected id set, and the Host stream emits `host/session-removed` with `deleted: true` for each removed log.

After physical removal, `SessionPersistence` emits the serial `session-persistence/deleted` event. The event fires once per delete call even when the log was already absent, allowing derived-data cleanup to retry after a crash between log removal and sidecar removal. The projection cache and message-feedback sidecar consume the event; feedback cleanup joins the sidecar's existing per-Session mutation queue so an in-flight put or delete completes before its row is removed.

The sidebar and Archived sessions surface share one confirmation dialog. The dialog states that deletion is permanent, prevents duplicate submission, and keeps a failure open for retry. A successful response follows the normal removal path, so all affected rows and retained Workspace/archive references disappear together.

## Alternatives considered

**Keep Archive as the only destructive-looking action** — Archive deliberately preserves the log and accounting slot, so it cannot satisfy removal of retained data. Renaming the action would only hide the missing capability.

**Remove the row from the client list without deleting the log** — this leaves storage, prompt revisions, subagent descendants, and sidecars behind; later reconnect or search would expose the supposedly deleted conversation.

**Delete only the selected log and leave lineage records for a separate sweep** — prompt revisions and descendant subagents would become dangling identities, and a crash would make the visible result depend on how much of the sweep ran.

**Soft-delete or recycle-bin state** — the product has no restore or retention contract for deleted Sessions, and adding tombstones would complicate every list, resume, and storage query for an unrequested recovery flow.

**Auto-cancel a busy Session and delete it** — cancellation changes running work and external side effects; the caller must first reach a safe quiescent state. Rejecting the request with `agent-busy` keeps destructive intent explicit.

**Infer deletion from `session/disposed` or `host/session-removed`** — both also describe detach or ordinary list removal, so treating them as durable deletion would erase valid derived data during normal lifecycle changes.

## Consequences

Permanent deletion is intentionally irreversible and confined to a confirmed user action. Partial cascades converge on retry because descendants are removed first and the requested identity remains last; repeated deletion of an already-missing log remains safe for derived cleanup. Derived stores must handle the deletion event idempotently and must not interpret detach as deletion. Direct subagent deletion remains unavailable from the product surface, so the parent-owned cascade owns that lifecycle.

## Testing

The shared persistence contract covers missing, materialized, and zero-event deletion plus id reuse across the memory, JSONL, and SQLite providers. Coordinator tests pin write ordering, event delivery on retries, and physical removal. Message-feedback tests cover durable cleanup, repeated deletion, and cleanup ordered behind an in-flight mutation. Host and web tests cover revision/subagent cascading, busy rejection, Workspace/archive cleanup, frame emission, confirmation, and the real browser flow.

## Related

The [domain KV storage proposal](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) keeps its remaining storage and Workspace work separate from this shipped Session-delete implementation. The [archive-set decision](../feature/2026-07-31-session-archive-global-set.md) remains the non-destructive visibility feature, and the [message-feedback sidecar decision](../architecture/2026-08-10-message-feedback-sidecar.md) owns the derived-data cleanup contract.
