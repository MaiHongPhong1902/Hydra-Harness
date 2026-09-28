# Agent Note: Agent file review

Status: implemented

## Problem
Agents need durable evidence for local file writes and safe review actions after restart.

## Decision
Capture local Write/Edit/Create mutations under the provider lock. Store SHA-256 hashes, bounded diffs, raw before bytes when within the configured limit, and session/tool lineage in atomic metadata. Keep marks a record reviewed; Undo restores only after owner, path, before snapshot, and current after hash checks. Pending or undoing records remain unavailable after interruption. A listing skips a change directory whose record has not committed, so a read concurrent with a mutation returns the committed records instead of failing.

## Alternatives considered
PI Desktop stores review state in tool messages and has no Keep action. Git based history cannot preserve tool attribution or survive reset. Best effort capture was rejected because an untracked mutation is unsafe to undo.

## Consequences
Review evidence survives Git operations and restart, and sequential edits require reverse-order undo. The aggregated panel is a desktop right-panel tab, so a browser-only frame reaches review evidence through the inline rows. Large or binary files may be reversible without text previews; shell, external editor, Delete/Move, and non-local providers remain unsupported. Hash checks do not prevent a separate process racing after validation. `verify-cordis-config` requires every `@hydraharness/harness-client-*` Loader row to declare `pluginType: core`, so a browser-roster row cannot silently drop to runtime-applied enablement.

## Verification
The fs-review tests cover create, edit, reverse-order undo, external conflicts, restart, Git operations, ownership and snapshot corruption, binary and size limits, interrupted mutations, and listing past an uncommitted change directory. `scripts/verify-cordis-config.spec.ts` pins the client-row classification rule. The client tests cover wire failures, refresh, inline and panel rendering, Keep, Undo, recorded hunks, attribution, and disposal. The assembled browser scenario covers Write/Edit, Keep, conflicting older Undo, reverse-order Undo, reload persistence, expanded diff, and attribution.
