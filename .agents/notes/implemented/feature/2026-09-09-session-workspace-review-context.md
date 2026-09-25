# Agent Note: Session workspace review context

Status: implemented

## Problem

Review needs to show changes in the selected session workspace, including external edits, while retaining exact attribution and safe Undo for agent changes.

## Decision

The host resolves `review.workspace` from the recorded session cwd and reads local Git metadata and comparisons. Clients cannot supply a filesystem path. Branch/commit selectors use repository results, and nested workspaces show only files below their cwd. Output and subprocess time have configurable limits; stale client responses cannot replace a newer comparison.

Automatic branch comparison uses only the current branch's upstream. A detached HEAD requires an explicit base reference: other local branches' upstreams do not identify the intended comparison.

The [Review UI](../../../../packages/client/ui-review/README.md) renders live Git files and [persisted agent records](2026-09-08-agent-file-review.md) through the same diff renderer and file tree. Keep and hash-guarded Undo use only persisted records. UI labels identify session history separately from Git comparisons. Refresh, host review notifications and reconnects preserve the chosen comparison.

## Alternatives considered

Using Git as agent history loses tool attribution and safe snapshot restoration. Embedding reference names or routing missing workspaces to the host checkout can show another project's files. The host-owned cwd and separate evidence types avoid both mistakes.

## Consequences

Review supports unified/split diffs, word highlighting, whitespace filtering, file search, navigation and complete text patch copying. Git must be installed locally; plain folders retain agent history. Commit/push, staging, comments and rich previews remain outside this implementation. The [UI presentation decision](2026-09-09-antigravity-file-review-ui.md) continues to own the lightweight renderer rationale; this note owns workspace authority and comparison semantics.

## Verification

Focused client and host tests cover scope selection, stale responses, nested workspaces, commit/branch comparisons, limits, cancellation and guarded actions. The assembled file-review browser scenario owns the visible Review snapshot and reload/Undo behavior.
