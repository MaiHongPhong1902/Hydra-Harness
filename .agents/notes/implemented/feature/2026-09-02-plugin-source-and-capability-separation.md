# Agent Note: Plugin source and capability separation

Status: implemented

## Problem

Marketplace combined source management with individual plugin management, while imported OpenAI/Codex bundles printed skills, MCP servers, and hooks in one dense line. The layout obscured whether an action changed a marketplace source, a plugin, or a specific capability.

## Decision

The loopback **Marketplace** tab manages OpenAI/Codex marketplace sources and imported bundle lifecycle: its add dialog persists the source and imports the selected catalog entry into the Hydra home, while bundle cards enable, disable, and remove imports. A catalog with one entry needs no plugin name; a catalog with multiple entries requires one. The **Plugins** tab lists native Hydra deployment plugins with their enablement controls. **Skills** lists imported skills, the existing **MCP** tab owns imported MCP-server enablement, and **Hooks** owns imported hook trust. Bundle cards do not duplicate those capability controls.

The imported bundle runtime keeps source-qualified lifecycle and trust state from [Codex-compatible imported plugin runtime](2026-09-01-codex-compatible-imported-plugin-runtime.md). The source format and removal of native Hydra marketplace installation are recorded in [OpenAI/Codex marketplace ownership](../simplification/2026-09-02-openai-codex-marketplace-ownership.md).

## Alternatives considered

**Keep imported bundles in Plugins.** Rejected because it split the OpenAI/Codex flow between source management in Marketplace and installation/lifecycle in Plugins.

**Keep capability groups inside the bundle card.** Rejected because the card duplicated the management locations for skills, MCP servers, and hooks.

## Consequences

Marketplace owns the complete OpenAI/Codex source and plugin-lifecycle flow without a Hydra package-install path. Native Hydra Plugins, imported Skills, MCP, and Hooks keep separate ownership, and focused client tests cover tab injection, bundle lifecycle, capability grouping, hook trust, and MCP server toggles.
