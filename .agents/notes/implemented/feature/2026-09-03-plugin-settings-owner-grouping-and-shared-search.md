# Agent Note: Plugin settings owner grouping and shared search

Status: implemented

## Problem

The Plugins, Skills, Hooks, and Marketplace tabs each rendered their rows as one flat list, so a deployment with plugins from several marketplaces had no way to see which plugins came from which source. Separately, only the Plugins tab's native-plugin catalog had a search box, and it filtered only that one list — Skills, Hooks, Marketplace, and MCP had no way to narrow a long list at all.

## Decision

`ui-settings-plugin-inventory` gained a shared pure helper, `marketplace-owner.ts`: `marketplaceOwnerLabel(source)` derives a marketplace's default group name from the path segment right after its domain (`https://github.com/DietrichGebert/ponytail` groups as `DietrichGebert`), falling back to GitHub-shorthand/scp-style Git owners and finally to a local root's own folder name (which has no owner). `groupByOwner(items, ownerSource)` groups by that label, sorted by owner name. The Plugins tab's imported-bundle list, the Skills tab, the Hooks tab, and the Marketplace tab all group their rows this way — an imported plugin's group key is its `source.marketplace` when it came from a marketplace, or its own `source.source` otherwise, so a directly-imported plugin gets its own single-plugin group.

`ui-settings-plugins`' `PluginsSettingsSection` now renders the surface's one search box, above the tab strip, applying regardless of which tab is active. `SettingsPluginsTabOwnerProps` (in `ui-settings`'s slot contract) widened from an empty marker to carry `query: string`; the section passes its current text through `renderSlot('settings.plugins.tab', { query }, { only: row.id })`, so every tab receives it as an ordinary owner prop. Each tab filters its own rows against that text — plugin/skill/hook names and, for Marketplace, the source string and its owner label — independent of the others; the MCP tab (in the same package) filters its native and imported rows the same way without needing the grouping helper, since MCP was never asked to group by owner.

## Alternatives considered

**Per-tab search boxes, unified only in copy.** Rejected: the requirement was one input, not five inputs that happen to look alike.

**Derive the owner from `source.sourceId`'s hash.** Rejected: the hash carries no readable owner name; the path segment after the domain is both what the request asked for and directly legible in the UI.

**Share `marketplace-owner.ts` across packages via a new dependency.** Rejected: grouping applies only to the four tabs already living in `ui-settings-plugin-inventory`; MCP only needed the query text, so `McpSettingsTab.tsx` keeps its own two-line `matchesQuery` closure rather than adding a cross-package dependency for it.

## Consequences

A deployment with plugins from multiple marketplaces sees them sectioned by owner everywhere that lists them, and one search box narrows Plugins, Skills, Hooks, Marketplace, and MCP together. `marketplace-owner.ts` has a dedicated unit-test file covering every parsing branch (HTTPS URL, scp-style Git, GitHub shorthand, local-root fallback, and the degenerate empty-source case); the four grouping tabs and the MCP tab each gained query-filtering and (where applicable) owner-grouping test coverage, including a marketplace-shaped fixture plugin with populated skills, hooks, and an MCP server sourced from `https://github.com/DietrichGebert/ponytail`.
