# Agent Note: New Session composer stays live across Workspace attach-frame lag

Status: implemented

## Problem

Opening New Session already creates or reuses a Host blank session for the chosen Workspace, but the hero composer stayed in the no-Workspace picker posture until the user clicked that same Workspace again. `session.create({ workspaceId })` returns before `host/workspace-changed` prepends the new id onto `sessionIds`, and the create echo omitted cwd, so `ConversationRoot` treated a ready list with no account hit as a deleted Workspace. Enter and Space on the read-only textarea opened the picker instead of submitting, so typed prompts and slash commands (`/plugin install`, `/echo`, …) could not run until that second pick. A second New Session in the same window could also mint another blank because reuse still required the lagged account slot ([reuse membership](2026-08-05-workspace-blank-session-reuse-membership.md)).

## Decision

`connectWorkspace`'s create arm fills the new session row's cwd from the Workspace path (local list echo; not sent on the wire) and prepends the id onto that Workspace's local `sessionIds` before the promise resolves. The hero then resolves ownership as account membership **or** a listed Workspace whose path equals the session cwd, and keeps the composer editable. A listed path match is not treated as deleted-Workspace recovery: that placeholder remains only when no row matches account or path. Typed slash commands keep using the existing session-addressed catalog and submit transaction once the textarea is live; they do not grow a pre-Session command path.

## Alternatives considered

**Wait for `host/workspace-changed` before opening the session.** Rejected because the unary create already proves attach succeeded, and holding navigation would restore the settling flash the startup auto-selection path removed.

**Keep the picker posture until `sessionIds` includes the id.** Rejected because that is the bug: the Host frames are not on the RPC response path, so the user always has to re-pick.

**Accept drafts before any Workspace exists.** Rejected earlier by the [picker-entry decision](../feature/2026-08-07-workspace-picker-composer-entry.md); this change only stops a false no-Workspace reading after create.

## Consequences

New Session is editable as soon as `connectWorkspace` resolves, including startup auto-selection and a sidebar `+`. A follow-up connect in the same client reuses the locally accounted blank instead of minting. Membership that arrives only through Host frames (another tab, or a `workspace.list` refresh that completes without the id) can still drop the local account until the changed frame; cwd-path matching still keeps that session's composer live. An Ungrouped blank whose cwd equals a registered Workspace path also shows that chip and accepts input — picking the chip still runs `connectWorkspace`, which mints an accounted session rather than adopting the stray.

## Testing

`packages/client/runtime/tests/workspaces-service.client.spec.ts` asserts the create arm stamps cwd and local `sessionIds` and that a second connect reuses. `packages/client/ui-conversation/tests/skeleton.client.spec.tsx` asserts a blank hero whose cwd matches an un-accounted Workspace row stays editable and submits a typed slash line through the default sink.

## Related

- [Workspace New Session reuse membership](2026-08-05-workspace-blank-session-reuse-membership.md)
- [No-Workspace composer opens the picker](../feature/2026-08-07-workspace-picker-composer-entry.md)
- [Workspace UI product flow](../feature/2026-07-25-workspace-ui-product-flow.md)
