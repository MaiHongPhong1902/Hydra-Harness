# Agent Note: Scalable provider account management

Status: implemented

## Problem

A provider editor with 100 accounts renders every quota report and requests every account's usage on entry. Long inventories also push Add account beyond the visible area and require repeated individual removals. Deleting one account restarts usage work for the entire remaining pool.

## Decision

The account inventory searches all account labels and IDs, renders ten matching rows per page, and bounds the list's height. Add account appears before the inventory. Multi-account pools start collapsed and expand one quota report at a time; a sole account retains its automatic report. Completed reports remain cached within the editor until successful login or explicit refresh. Leaving an expanded row aborts pending usage and discards late responses. Login hides the inventory until completion while preserving selection. A newly added identity clears search and opens on its page. Successful reconnection invalidates cached quota without fetching the whole pool.

Selection applies to the displayed page, survives search and page changes, and exposes its total in the removal action. Confirmation lists the selected identities. Removal uses the existing per-account Host operation sequentially, tracks progress, and reloads accounts once. Only acknowledged removals clear selection; failed accounts remain available for retry. A failed final listing cannot restore accounts whose removal was acknowledged. Unmount stops subsequent removals after the current request returns. Browser sessions remain outside these local credential operations.

## Alternatives considered

**Render every account with automatic usage.** Rejected because DOM size and provider traffic grow with the pool while most reports remain outside the viewport.

**Virtualize rows while fetching every quota.** Rejected because virtualization does not reduce provider calls and adds scroll measurement without improving account search or selection.

**Remove the entire account pool.** Rejected because users need a reviewed subset and recoverable partial failures.

## Consequences

Opening a 100-account fixture makes no usage requests. Expanding one row makes one request without loading adjacent accounts. Search spans the pool without fetching usage. Keyless component tests cover cancellation, cached reports, read-only operation, partial removal, and editor teardown. An assembled browser scenario verifies 100 accounts, selection across pages, credential persistence, and narrow light/dark layouts. The UI uses provider-reported usage; test fixtures do not establish live provider availability.
