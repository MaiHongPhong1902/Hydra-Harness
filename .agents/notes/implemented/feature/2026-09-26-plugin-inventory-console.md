# Agent Note: Installed plugin inventory console

Status: implemented

## Problem

The Plugins settings tab presented installed entries as large cards, so scanning runtime state, comparing enablement, and finding restart-pending core changes required opening several unrelated sections. Details such as Cordis phase and preset scope also competed with the primary enablement controls, and an empty details column could hide plugin names in a narrow panel.

## Decision

The installed Plugins tab presents native and imported entries in compact rows with type, runtime status, enablement, and pending-change indicators. A toolbar filters by type and status and sorts by name or runtime state. Selecting a row opens a centered, document-level read-only details dialog containing Cordis phase, preset or new-session scope, related instances, and restart requirements; row controls remain the single place for changes, and the list always uses its full width. Core restart-pending changes appear in one global warning. The Save/Discard footer is rendered only while drafts or save errors exist; existing Host-owned controls and imported-plugin operations keep their current APIs and persistence behavior. A null Fiber phase is shown as Not mounted for Host-owned rows; Starting is reserved for an enabled entry whose Fiber is pending, loading, or unloading. Preset roster rows are labeled Session-scoped because this inventory does not own or observe the Fiber of an individual session.

## Alternatives considered

**Keeping the card layout and adding more badges.** Rejected because the card footprint still prevents a useful inventory view and leaves cross-entry comparison difficult.

**Keeping details in a side drawer.** Rejected because the narrow Settings surface made the drawer compete with the inventory table and left the popup visually attached to the wrong context.

**Moving all details to a separate page.** Rejected because a modal keeps the current settings flow and preserves the selected entry's context without leaving the inventory.

**Replacing Host runtime data with client-derived state.** Rejected because runtime status, restart requirements, ownership, and persistence remain Host-owned facts.

## Consequences

The Plugins tab is denser and supports quick filtering while retaining accessible switches, keyboard row selection, and existing save semantics. Details are discoverable on demand in a centered, focus-managed dialog, so the table stays focused on inventory state. The dialog reads description and intended application from each native package or imported manifest through Host projections, keeping plugin guidance with the plugin metadata. Imported and native records share the visual language but retain separate operation paths. The compact layout collapses to one column on narrow screens while the dialog remains viewport-bound.

## Testing

Focused inventory component tests cover row selection, grouped-module details, filtering, pending core restart state, and saved settings. The assembled Web settings scenario covers row and dialog interaction, draft and saved details, and the restart-pending dialog snapshots. The package TypeScript aggregate, targeted oxlint, and UI-control gate pass for the changed surface.
