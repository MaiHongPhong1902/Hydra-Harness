# Agent Note: Settings Plugins ownership and Codex compatibility

Status: implemented

## Problem

Settings > Plugins combines native Hydra plugin state, imported OpenAI/Codex and Claude bundles, marketplace sources, user-owned MCP and hook records, and plugin-owned settings cards. These facts have different Host services and different browser owners, so a tab or Remote can appear to own state it only projects. Codex- and Claude-compatible files also have a broader component vocabulary than the importer currently executes.

## Decision

Host services are the source of truth; Settings is a projection with staged browser drafts. The following matrix is the authoritative ownership map for the section.

| Concern | Durable or live source of truth | Host projection and mutation path | Browser owner |
| --- | --- | --- | --- |
| Plugins section and tab list | Client slot ledger (`settings.plugins.tab`) plus the section's local query and visited-tab state | None; the section composes browser contributions | [`ui-settings-plugins`](../../../../packages/client/ui-settings-plugins/README.md), `PluginsSettingsSection` |
| Configurable Host plugin settings | Registered `ctx.settings` namespaces and the shared `settings.describe` mirror | `settingsScope.describe` and namespace-scoped settings writes | `ConfigurablePluginsTab` and keyed `settings.plugin.item` cards in [`ui-settings-plugins`](../../../../packages/client/ui-settings-plugins/README.md) |
| Native Hydra plugin enablement | Loader entries and `plugins.enabled`, `hydra.profile.pluginEnablement`, or `agent-presets.pluginEnablement` according to entry ownership | `ctx.pluginInventory` `list`/`setEnabled` | `PluginInventorySettingsTab` and `PluginInventoryController` in [`ui-settings-plugin-inventory`](../../../../packages/client/ui-settings-plugin-inventory/README.md); drafts apply through one Save |
| Imported bundle install and lifecycle | `ctx.importedPlugins` registry, immutable cache, and writable plugin data | `pluginInventory` `listImportedPlugins`, `importPlugin`, `enablePlugin`, `disablePlugin`, and `removePlugin` | Imported rows in `PluginInventorySettingsTab`; `/plugin` commands use the same Host runtime |
| Marketplace sources | `plugin-marketplaces.sources` | `pluginInventory` marketplace Remotes validate and persist sources; selected entries are staged through `ctx.importedPlugins` | `MarketplaceSettingsTab`; it owns sources and cascades, not bundle runtime state |
| Imported skills | Enabled bundle manifest and `ctx.skills` registrations | `listImportedPlugins` projects names; enable/disable goes through imported-plugin lifecycle | `ImportedPluginCapabilitiesTab` Skills tab |
| Imported hooks | Bundle hook definitions plus the imported registry's digest-based trust state | `listImportedPlugins`, `trustPlugin`, and `untrustPlugin` | Imported hook child of the shared Hooks tab; user hook records remain owned by `ctx.hookRecords` |
| Imported MCP servers and tools | Bundle manifest plus per-server and per-tool state in `ctx.importedPlugins` | `listImportedPlugins` and `setPluginMcpServerEnabled`; runtime also owns approval state | Imported rows in the MCP tab; tool approval is runtime policy and has no Settings Remote mutation in this surface |
| User MCP servers | `ctx.mcpServers` and the `mcp-servers.servers` settings section | `listMcpServers`, `defineMcpServer`, `setMcpServerEnabled`, and `removeMcpServer` | User MCP catalog in the MCP tab |
| User hooks | `ctx.hookRecords` and the `hooks.records` settings section | `listHookRecords`, `defineHookRecord`, `setHookRecordEnabled`, and `removeHookRecord` | User hook catalog in the Hooks tab |

The imported runtime accepts the legacy `.codex-plugin/plugin.json` format, the portable root `plugin.json` format only when the Agent Plugins schema is declared, and the Claude `.claude-plugin/plugin.json` format for the shared skills, MCP, hooks, root command, and root skill subset. Portable manifests default to root `skills/` and `mcp.json`; `extensions.com.openai` supplies host-specific app, hook, and interface metadata. The runtime validates and mounts data through declared skills, commands, MCP, and seven supported synchronous hook events, while `.app.json` and interface metadata remain inert. Claude manifest fields and filesystem components without a Hydra equivalent are rejected during import.

Codex ecosystem compatibility is intentionally recorded by component instead of by a single yes/no label.

| Codex component | Current Hydra support | Boundary |
| --- | --- | --- |
| Legacy and portable plugin manifests | Supported | The portable root requires the Agent Plugins schema; unsupported schema versions fail closed. |
| `skills/` and `SKILL.md` | Supported | Imported skills mount through the shared skill provider; the native Codex skill catalog is not imported as a separate source, and Claude's root `SKILL.md` form is accepted. |
| MCP declarations | Partial | Inline declarations and file-based stdio/HTTP definitions mount, including Claude's `.mcp.json` fallback; authentication metadata and tool-approval editing are not fully projected through Settings. |
| `hooks/hooks.json` and manifest hook declarations | Partial | Definitions are validated and digest-trusted through seven supported synchronous command events (`PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStart`, and `SubagentStop`); the complete Codex event vocabulary is not executable here. |
| Plugin commands | Partial | Hydra loads root TOML and Markdown command files, including Claude's shared root `commands/` form; manifest-declared or custom command paths are rejected. |
| `agents/openai.yaml` metadata | Partial | OpenAI presentation and `policy.allow_implicit_invocation` are projected; custom `agents/*.md` definitions are not executed. |
| Apps and interface metadata | Metadata only | Files are parsed for projections or path validation; no executable Codex app/interface runtime is mounted. |
| Marketplace catalogs | Partial | `.agents/plugins/marketplace.json`, `.agents/plugins/api_marketplace.json`, root `marketplace.json`, local roots, and Git sources are supported; daily sync, marketplace policy, upgrade selection, and rollback selection are not. |
| Claude plugin manifest and unsupported components | Partial | `.claude-plugin/plugin.json` imports the shared subset; unsupported manifest fields (`commands`, `agents`, `lspServers`, `monitors`, `outputStyles`, `themes`, `settings`, `dependencies`, `bin`, `apps`, and `interface`) and filesystem components (`agents`, `output-styles`, `themes`, `monitors`, `bin`, `.lsp.json`, and `settings.json`) fail explicitly instead of being silently ignored. |
| Codex browser/UI extensions | Unsupported as imported runtime | Hydra UI plugins use its own `hydra.client` slot system; imported bundle UI metadata does not execute a browser component. |

## Alternatives considered

**Put the matrix in `docs/capability-seams.md`.** Rejected because that page's generated service table is authoritative for `ctx` seams, while this matrix also describes browser slots, staged drafts, and external-format limits.

**Repeat the full matrix in each package README.** Rejected because duplicated ownership claims drift; package READMEs link to this note and retain only their local contract.

**Treat imported Codex bundles as native Hydra Loader plugins.** Rejected because native entries use Cordis Loader/profile persistence, while imported bundles use source-qualified identities, an immutable cache, writable plugin data, and digest-based hook trust.

## Consequences

The Plugins section can expose a single navigation surface without becoming a second state store. A Settings control is correct only when its Remote routes to the service named in the matrix; adding a new imported capability requires updating the runtime projection and its browser owner together.

The importer is useful for the Codex core of skills, MCP, supported hooks, commands, and marketplaces, and for the shared Claude subset. Compatibility remains partial where a component is explicitly rejected, represented as inert metadata, or lacks a Hydra runtime equivalent. The package READMEs link here so their limitations and the matrix share one owner.

## Testing

The matrix is checked against the owning package source and Remote names in `packages/host/plugin-runtime`, `packages/host/plugin-inventory`, `packages/client/ui-settings-plugins`, and `packages/client/ui-settings-plugin-inventory`; focused validation for this note is `pnpm run verify-agent-note-format`, `pnpm run verify-md-links`, and `git diff --check`.
