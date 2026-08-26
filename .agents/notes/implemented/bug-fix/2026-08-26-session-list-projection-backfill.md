# Agent Note: Backfill missing client projections during Session listing

Status: implemented

## Problem

`session.list` served cold Session projection values only from version-matching checkpoint rows. A newly registered client projection therefore stayed absent from every older Session until that Session was opened or resumed. The Usage settings page read `modelTokenUsage`, while existing checkpoints contained only the older `tokenUsage` row, so durable provider usage existed but the cross-Session table remained empty.

## Decision

`SessionProjectionRegistry.checkpointHasCurrentViews()` reports whether every registered client-visible unit has a version-matching row whose state and rendered value pass the current schemas. Host-only units do not participate because a browser listing cannot consume them.

`SessionProjectionCache.listSnapshot()` serves the existing zero-log checkpoint cut when that predicate passes. Otherwise it uses the existing `coldSnapshot()` ladder, whose restore floor makes a missing or version-mismatched unit refold from sequence zero, writes the complete refreshed checkpoint back, and returns the new values. `session.list` uses this method only for cold Sessions; attached Sessions still read the live registry snapshot. A failed backfill omits that row's projection block without failing the Session list.

## Alternatives considered

**Assign `tokenUsage` to the Session's latest model in the browser.** Rejected because one Session can switch providers or models, so the fallback would produce plausible but false billing attribution.

**Read every cold log on every listing.** Rejected because list cost would scale with total transcript bytes on every refresh even after the checkpoint already contains every current client value.

**Add a `modelTokenUsage`-specific migration.** Rejected because the same omission recurs for the next client projection or `stateVersion` bump; completeness belongs to the generic projection registry and cache.

## Consequences

The first list after a client projection is added, versioned, or found invalid may perform one full-log read per affected cold Session under the gateway's existing bounded batch concurrency. Successful reads write back complete checkpoints, so later lists return to zero-log cache reads. Host-only projection changes never add listing I/O.

Focused registry, cache, and gateway tests pin current-view completeness, one-time backfill and write-back, the second-list zero-read path, attached live snapshots, and fail-soft cold rows.
