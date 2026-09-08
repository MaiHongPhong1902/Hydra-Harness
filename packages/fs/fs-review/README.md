# File review

`@hydra/harness-fs-review` provides `ctx.fileReview`: chronological, session-owned Write/Edit/Create evidence, Keep, and hash-guarded Undo. [PI source map](PI-SOURCE-MAP.md) records the implementation studied and explicit differences.

The local filesystem emits `fs/mutate` inside its existing per-file lock, after the sandbox fence. The review plugin captures raw bytes before delegating and commits SHA-256 hashes, attribution, counts, and bounded hunks outside the workspace. Git operations cannot erase these records. Keep marks an applied change reviewed and retains Undo; it does not write the workspace or change tool permissions.

Undo verifies the owner, workspace, canonical path, snapshot hash and current after hash. New files are removed. Sequential edits must be undone in reverse order when their post-edit states differ. Interrupted pending/undoing records remain unavailable and never trigger automatic restoration. Records use the tool execution's session, tool call, root call, turn/step sequence, preset and parent session metadata.

## Configuration

`directory` defaults to `$HYDRA_HOME/review-changes`. It must be absolute and outside the tracked workspace. `snapshotMaxBytes` defaults to 16 MiB inclusive; larger existing files have hashes but no reversible before copy. `diffMaxBytes` defaults to 512 KiB per side, `diffMaxLines` to 4,000, and `diffMaxCells` to 2,000,000. Preview limits do not discard snapshot bytes. Binary or invalid UTF-8 content has no text preview.

## Storage and actions

Each session directory is the SHA-256 of its session id, containing UUID change directories with a raw optional `before` file and versioned `meta.json`. `ReviewChange` owns the session/call/turn/step/preset lineage, relative path, hashes, status, state, and stored hunks. `ChangeId` identifies this directory. `ReviewOutcome` returns the record plus kept, rolledBack, alreadyRolledBack, conflict or unavailable. The [source map](PI-SOURCE-MAP.md) documents all PI comparisons.

Startup removes review directories for sessions absent from persistence and the live session store. A failed mutation discards evidence only when the target still equals the before hash. Surviving sessions retain their records without age expiry; no session-deletion API is available for immediate deletion cleanup. No automatic recovery writes workspace files.

## Model Experience

None, as review evidence is user-facing storage keyed to existing session/tool identities.

#### KV Cache effect

None; review records are not model request inputs.

## Known Limitations and Deferred Work

- Shell commands, external editors, Delete/Move tools and non-local filesystem providers do not produce reversible review history. External edits are detected by Undo's current hash.
- Cooperating local writes share a provider lock; an unrelated process can still race the final check and OS publication. The service retains uncertain operations for inspection instead of guessing after a crash. Snapshot preparation failure prevents an untracked mutation, a deliberate difference from PI's best-effort capture.
- Metadata replacement is atomic, but the shared atomic-write helper does not fsync metadata or directory entries. Power-loss durability is not guaranteed. A stale action lock after process failure requires operator inspection; the service never steals it.
