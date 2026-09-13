# Agent Note: Settings plugin state ownership

Status: implemented

## Problem

The MCP tab exposed a direct Obsidian plugin enablement write while the Plugins tab staged the same entry until Save. Marketplace mutations could also cascade imported plugin state while the Plugins tab held pending enablement drafts. Imported MCP rows exposed raw lifecycle enum values, and an accepted credential write could clear its draft when credential read-back failed.

## Decision

Plugin enablement is owned by the Plugins tab's staged inventory controller. The MCP tab reads the native entry and shows its status without a second switch; when that entry is disabled, the tab still exposes the independent credential editor while inventory confirms the plugin is composed. Marketplace remove and enablement actions refuse to run while imported plugin drafts are pending, so a later Save cannot overwrite a marketplace cascade or target a removed identity. Imported MCP lifecycle states use localized labels, and credential saves require both an accepted write and a successful read-back before clearing the draft.

## Alternatives considered

Sharing one mutable draft store with marketplace state would widen the inventory controller across two feature plugins. A page-level guard keeps the existing remote APIs and prevents the stale write with a smaller ownership change.

## Consequences

Users change native plugin enablement in one place and receive an actionable marketplace message when pending plugin changes must be saved or discarded first. MCP status remains observable without implying that its tab owns plugin lifecycle, while its credential remains editable for a composed but disabled plugin. Failed credential read-back remains retryable instead of reporting an unverified success.

Focused client tests cover the single native control, localized imported MCP states and search empty state, credential read-back failure, disabled-plugin credential editing, and marketplace mutation blocking.
