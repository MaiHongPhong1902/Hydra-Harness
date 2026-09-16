# Agent Note: Session summary header overview

Status: implemented

## Problem

The Session header exposes a Session log export, but users cannot quickly see which workspace, repository, branch, and file evidence belong to the selected session. Git actions are also outside the current Hydra review API.

## Decision

The Review plugin registers a `Session summary` utility beside the Session log. It opens a compact, anchored, nonmodal popover that keeps the transcript visible and dismisses on Escape or an outside press. Changes is collapsed with colored additions and deletions before its comparison, file, line, and session-edit details; Local contains session and host metadata; the branch row contains repository and recent commits. Commit or push and pull-request rows stay disabled because Hydra has no Git mutation API. Sources previews three loaded attachments and expands through `View all (N)`, with a partial-history notice when older messages are not loaded. A Subagents row appears only when child sessions exist. The summary reads framework-bound session, workspace, and host hooks plus the shared ReviewHistory active comparison; loading, unavailable, and error states remain explicit and do not claim a repository or zero counts.

## Consequences

The summary shares the ReviewHistory cache and the framework's session, workspace, and host hooks, so opening it adds no transport or persistence path. Refreshing the workspace uses the active comparison already owned by ReviewHistory and leaves the Review panel's selected scope intact. The source preview is limited to loaded history, and unsupported Git mutations remain visibly unavailable. A host without workspace review still shows session metadata and the explicit loading, unavailable, or error state for the comparison.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Render a full modal with every field expanded | The anchored popover keeps the session context visible and lets users open only the details they need. |
| Add a second Git client or shell probe | The Review API already owns session-scoped Git comparisons and redaction. |
| Put the control in the conversation shell | Header utilities are an extension slot; the Review plugin owns change and repository evidence. |
| Trigger commit, push, or pull-request workflows | No corresponding Hydra API exists, and a summary control should remain read-only. |
