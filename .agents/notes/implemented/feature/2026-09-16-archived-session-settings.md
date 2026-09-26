# Agent Note: Archived sessions settings restoration

Status: implemented

## Problem

Archiving hides a Session from every Workspace browsing surface while retaining its log and Workspace membership, but users need a durable way to find the hidden Session and return it to the same Workspace.

## Decision

The `ui-workspace` plugin contributes an `Archived sessions` page to the Settings section ledger. The page reads `useWorkspaces().archivedSessionIds` in Host order, enriches each id from `useSessions()` and retained Workspace `sessionIds`, and supports checkbox selection with bulk restore and permanent deletion. Restore calls `ctx.workspaces.unarchiveSession` in archive order through the injected action. The runtime removes only the archive marker, so the retained `sessionIds` slot restores the Session to its original Workspace. Missing metadata remains visible by id and can still be restored. Bulk deletion reuses the permanent deletion dialog and retries only failed ids.

## Alternatives considered

**A sidebar archive group:** Rejected because archived Sessions must stay out of every grouping surface; Settings provides a stable recovery location without changing browsing semantics.

**Client-side Workspace reassignment:** Rejected because the Host archive set and Workspace accounting are the durable authorities; the client only requests unarchive and renders the resulting projection.

## Consequences

The Settings page remains available even when no Sessions are archived and reports restore failures without removing the row. Selection is local UI state; each successful bulk operation removes its id from selection after the Host acknowledgement. The page depends on the runtime unarchive and delete verbs and cannot restore or delete a Session when the Host rejects that request.
