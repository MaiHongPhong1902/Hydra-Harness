# Agent Note: Page Memory Settings card

Status: implemented

## Problem

Page Memory could be mounted through Cordis but had no Settings entry for its namespace, so operators had to edit composition files to change its role, storage, and retention limits.

## Decision

The Host plugin registers the `page-memory` settings namespace with its composition values as the base layer and declares `restart` applies. The existing `ui-settings-plugins` package contributes a keyed card for that namespace, using the shared staged `CardForm` and `PluginCard` surfaces. The card edits role, locale, storage directory, record and retention limits, context size, observations, and verification timeout. On activation, the Host merges persisted settings over the composition values before opening the store.

## Alternatives considered

**Add a separate client package.** Rejected because the existing Plugins settings package already owns the keyed card slot and can host one more feature card without another bundle or registration surface.

**Keep settings display-only.** Rejected because the Settings scope already provides staged writes and the page-memory runtime can resolve the persisted values during restart.

## Consequences

Page Memory appears under Settings → Plugins when its Host namespace is mounted, and saved edits take effect after restart. Deployments without a Settings provider retain the previous composition-only behavior. The workspace path and route table remain composition-controlled to avoid turning a UI edit into a broader workspace or routing authority change.

## Testing

Page-memory tests (28), Plugins settings tests (37), targeted typechecks, constraints, package invariants, and targeted oxlint pass. The documentation gate updated the generated catalogs; unrelated pre-existing client-catalog and Agent Note format failures remain outside this change.
