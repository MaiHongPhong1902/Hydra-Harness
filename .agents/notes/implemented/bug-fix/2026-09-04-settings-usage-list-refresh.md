# Agent Note: Settings Usage refreshes list projections on open

Status: implemented

## Problem

The Settings Usage page summed `modelTokenUsage` from the client session-list store. Live `session/projection` frames already rebuild that store, but opening the page never pulled `session.list`, so cold sessions kept whatever cut the last baseline or reconnect carried. After further turns elsewhere, reopening Usage could show stale totals even though the Host checkpoint and the chat stats line had moved on.

## Decision

The Usage section injects `sessions.refresh` and runs it once on mount. While the page stays mounted it continues to select aggregated `modelTokenUsage` from the list store with a row-equality check, so live frames still redraw the table without waiting for another pull.

## Alternatives considered

**Subscribe only to the current session's `useProjection('modelTokenUsage')`.** Rejected because Usage is a cross-session billing table and `settings.section` is root-scoped; the list store is the existing aggregation face for every listed session.

**Attribute bare `tokenUsage` to each session's latest model when `modelTokenUsage` is empty.** Rejected earlier for false billing when a session switches routes ([backfill note](2026-08-26-session-list-projection-backfill.md)).

## Consequences

Every visit to Usage issues one `session.list` (single-flight with any concurrent refresh). Cold rows pick up the Host's latest projection cut; the open session still follows push frames through the same store. Unit tests pin mount refresh and a live list update into the table.
