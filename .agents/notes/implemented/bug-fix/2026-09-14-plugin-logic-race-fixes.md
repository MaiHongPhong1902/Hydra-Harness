# Agent Note: Preserve plugin data and lifecycle state across async boundaries

Status: implemented

## Problem

Workflow array materialization accepted noncanonical enumerable keys and dropped them. Hook bridge failures at `SubagentStop` were detached without logging. Plugin inventory mutations could race staged imported-plugin changes, mislabel dirty imported entries, and miss an in-flight removal. The browser runner could finish a queued load after disposal and repopulate the live set.

## Decision

Require array keys to equal their canonical numeric string before materialization. Attach warning handlers to detached `SubagentStop` runs in both hook bridges. Block marketplace mutations while imported changes are pending or saving, and exclude dirty imported entries from startup-change indicators. Make runner disposal idempotent, reject new requests after disposal, and await queued operations before tearing down the live set.

## Testing

Regression tests cover noncanonical array keys, hook rejection logging, marketplace blocking, imported-plugin state projection, and deferred runner disposal. Focused tests pass: realm 15/15, plugin inventory 16/16, runner 31/31. Changed package typechecks and oxlint pass.

## Alternatives considered

Leaving detached hook promises unobserved would preserve the existing fire-and-forget behavior but hide failures. Allowing marketplace changes during a pending save would keep the UI responsive while permitting state races. Clearing the runner immediately would be shorter but would allow a queued load to publish after disposal. Each alternative loses observable error or lifecycle state, so the shared guards and queue drain remain local to the owning components.

## Consequences

Noncanonical array properties now fail loudly. Hook bridge failures produce warnings. Marketplace actions wait for a clean imported-plugin state, and startup indicators no longer report unsaved imported edits as persisted changes. Runner disposal may wait for an in-flight operation, and calls after disposal reject or no-op by operation type.
