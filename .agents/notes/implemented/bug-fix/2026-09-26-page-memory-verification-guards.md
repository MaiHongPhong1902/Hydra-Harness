# Agent Note: Bounded Page Memory verification inputs

Status: implemented

## Problem

Page Memory settings accepted integers beyond JavaScript's safe range and verification delays beyond the range supported by `AbortSignal.timeout`. Anchor verification also treated a shorter saved phrase as present inside a longer word, while formatting characters and whitespace could make equivalent observed text fail.

## Decision

Page Memory schemas accept positive safe integers for every numeric limit and cap `verificationTimeoutMs` at `2147483647` ms. Runtime validation keeps the same bounds before opening the store. Live anchor checks and source-page observations remove zero-width characters and soft hyphens, collapse whitespace, and reject expected text adjacent to letters, numbers, or underscores. The existing Browser verification continues to own unique CSS-selector checks; this change does not add selector uniqueness.

## Alternatives considered

**Leave numeric validation to the runtime timer and SQLite paths.** Rejected because invalid settings would cross the Settings schema and could overflow the timer delay before a useful Page Memory error identifies the field.

**Keep substring matching for observed text.** Rejected because a saved phrase such as `Archived` could pass against `ArchivedOrders`, allowing a changed page to reuse stale guidance.

**Require the whole targeted snapshot to equal the saved text.** Rejected because Browser observations include surrounding content; boundary-aware matching preserves that context while rejecting embedded-word matches.

## Consequences

Settings reject oversized integers before activation, and verification timers remain within the supported Node range. Equivalent whitespace and hidden-formatting differences no longer invalidate an anchor, while embedded-word matches become stale or unavailable until the agent observes the current page again. Combining marks and join controls remain part of adjacent words. Source-page checks use the same text rule as live checks. Incompatible SQLite schemas continue to fail closed; this change adds no automatic migration. Native Electron verification remains pending; the assembled Web Settings flow and ACP replay pass.

## Testing

`packages/knowledge/page-memory/tests/page-memory.spec.ts` covers unsafe numeric settings, the timer ceiling, and partial anchor text matches during live recall. The same matcher is used for source-page observations in the implementation. The assembled Web Settings flow passes in refresh and replay modes; the ACP page-memory snapshot passes. Native Electron interaction remains unverified.
