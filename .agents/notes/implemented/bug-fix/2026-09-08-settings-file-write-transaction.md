# Agent Note: derive settings writes under the file lock

Status: implemented

## Problem

The settings service derived a complete namespace section and checked its revision before the file provider acquired its writer lock. Reconciliation inside `persist()` observed external changes too late: a stale writer editing one provider could restore a sibling provider another process had deleted. A write carrying an obsolete revision could also overwrite an unseen file edit. Atomic rename protected file integrity but not the values being written.

## Decision

`SettingsProvider.withWriteTransaction()` surrounds revision checking, section derivation, validation, persistence, and in-memory commit. The file provider acquires its existing operation queue and writer lock, reconciles the document, then runs that callback. Unversioned `update` and `mutate` apply their edits to the current stored section; `replace` still replaces the whole section. Rejected revisions leave the file untouched and allow a refreshed retry.

This supersedes the same-namespace deferral in [settings write-path integrity](../architecture/2026-07-30-settings-write-path-integrity.md); its watcher, observer, comment-preservation, and lock-ownership decisions remain current. The [configuration-plane revision rule](../architecture/2026-07-30-config-plane-boundaries.md) also applies to file changes discovered during lock acquisition.

Callers that construct a complete array before writing must carry the revision of that read. The owner scope exposes `revision` without serializing unrelated namespaces. MCP and Hooks registry create, replace, enablement, and removal operations use the existing settings revision check. An unseen external write rejects their stale list and refreshes the local settings view for retry; merging arrays cannot recover record-level intent.

## Alternatives considered

**Lock only the final persist.** The incoming section already contains stale values, so a fresh read cannot recover the caller's intended edits.

**Merge the complete stale section with the file.** A merge cannot distinguish an explicit set from an inherited stale key, or preserve a deletion reliably. Applying the existing operation after reconciliation needs no three-way merge.

## Consequences

UI configuration and later file loads agree after successful writes. The provider holds the lock through validation and commit, making that interval slightly longer. Revisions remain registration-local; writers that ignore the file lock can still race it, and missed watcher notifications alone do not trigger a read.

Regression tests cover provider deletion, scalar/boolean resets, array removal, stale sibling edits in YAML and JSON, obsolete revisions for all three write modes, retry, and a fresh provider load. MCP and Hooks tests cover stale create, replace, enablement, and removal. The Models and Plugins browser scenarios check UI deletion, a stale second writer, retry, and reloaded Settings snapshots through the assembled application.
