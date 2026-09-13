# Imported plugin runtime

`@hydra/harness-plugin-runtime` mounts the shared `ctx.importedPlugins` service in `@hydra/harness-base`. It imports an OpenAI/Codex bundle whose root contains `.codex-plugin/plugin.json` or the portable root `plugin.json` with the Agent Plugins schema, or the shared skills/commands/hooks/MCP subset of an Anthropic Claude bundle whose root contains `.claude-plugin/plugin.json`, from a local folder, Git repository, or marketplace root. A portable manifest defaults to `skills/` and `mcp.json`; its `extensions.com.openai` section contributes host-specific apps, hooks, and interface metadata while canonical skills and MCP declarations stay at the manifest root. Marketplace import accepts `.agents/plugins/marketplace.json`, `.agents/plugins/api_marketplace.json`, the legacy root `marketplace.json`, and standard Git-subdirectory entries; direct plugin imports do not need a catalog.

The cross-package source-of-truth matrix and Codex compatibility boundary are in the [Settings Plugins ownership and Codex compatibility note](../../../.agents/notes/implemented/architecture/2026-09-14-settings-plugins-ownership-and-codex-compatibility.md).

The importer validates the manifest, declared component paths, package/file bounds, and the complete filesystem tree before and after staging. It rejects absolute paths, traversal, links, and junction escapes. Installed code is immutable at `$HYDRA_HOME/plugins/cache/<source-id>/<plugin-name>/<version>/`; writable state is `$HYDRA_HOME/plugins/data/<source-id>/<plugin-name>/`. Every record keeps a source-qualified identity (`<plugin-name>@<source-id>`) and installed versions. Reimporting the same identity updates it; another source cannot install the same manifest name until the existing record is removed.

Path containment compares native realpaths for both the plugin root and its descendants, including when a parent directory uses a Windows short-name or filesystem alias. Links declared inside the bundle still reject.

Enabling a record discovers `skills/<skill-name>/SKILL.md` files, root TOML or Markdown command files, and declared MCP servers. A unique imported skill also receives its frontmatter name as a short slash alias; a native/canonical or competing imported name keeps precedence. TOML commands require non-empty `description` and `prompt` strings; Markdown commands accept YAML frontmatter plus a non-empty body and use the first body heading as a fallback description. A same-name TOML command wins over its Markdown companion. Invoking a command creates a logged follow-up from its prompt with `{{args}}` and `$ARGUMENTS` replaced by the trimmed input. Native and earlier command names keep precedence. MCP definitions may be inline or loaded from portable `mcp.json` or legacy `.mcp.json`; direct maps and `mcp_servers`/`mcpServers` wrappers are accepted, and stdio `cwd` values stay inside `PLUGIN_ROOT`. MCP server enablement, default tool approval, and per-tool approval are independent state. Disabling unloads skills, commands, hooks, MCP processes, and tools deterministically.

Hooks default to `hooks/hooks.json`; a root `hooks.json` is also accepted for bundles that use that layout. A manifest `hooks` value overrides both defaults and may contain paths or inline definitions; relative paths resolve inside the plugin root. Discovery never trusts hooks. Trust is stored against the current hook-definition digest, so an upgrade or edit returns the hook to pending review. Trusted hook processes receive `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, and `CLAUDE_PLUGIN_DATA`; commands still run with the agent session cwd, so bundled scripts should use one of those variables rather than relying on a bare relative executable path. `.app.json` is parsed as inert app/MCP mapping metadata; it never executes.

Skill frontmatter uses the shared [`parseSkillDocument`](../../skill/skill/README.md#public-api) YAML parser, including folded descriptions, routing hints, and independent `disable-model-invocation`/`user-invocable` controls. Invalid metadata rejects import or enablement instead of defaulting to permission. Exact loads reparse the current document and policy; a renamed document cannot satisfy a stale selection. Both qualified names and short aliases retain the same invocation controls.

The optional `agents/openai.yaml` metadata file is read beside a plugin or skill. Its display fields are projected on imported plugin entries, and `policy.allow_implicit_invocation: false` makes the associated skill explicit-only. Tool dependencies and custom `agents/*.md` definitions remain data that this runtime does not execute because Hydra has no imported-agent registry.

The `/plugin` command manages these imported bundles (`list`, `import`, `install`, `marketplace add|list|remove`, `info`, `enable`, `disable`, `trust`, `untrust`, and `remove`). `/plugin marketplace add <source>` persists an OpenAI/Codex catalog through `pluginInventory` when that Host service is composed, and otherwise imports the source directly. `/plugin install <plugin>@<marketplace>` stages that catalog entry and enables it; `<marketplace>` may be a GitHub shorthand, Git URL, folder, or the repository name of a persisted source (`toolkit@toolkit` after adding `example-labs/toolkit`). The native `hydra plugin` CLI continues to manage Hydra harness package bundles. The Web Marketplace tab exposes the same source, version, lifecycle, skill, MCP, hook, app, and data projections through the Host inventory Remote.

Imported bundle views include `initialEnabled`, captured from persisted state when the runtime starts; bundles installed during this run start disabled. Settings uses it to retain change highlights until restart.

Component registrations and mounts belong to this Host service; disposing an API caller does not unload them. Enablement waits for each enabled MCP server's initial discovery to settle, and its returned view reports `started` or `failed`. A failed server does not prevent sibling capabilities from mounting.

An explicit manifest `mcpServers` declaration replaces the portable `mcp.json` or legacy `.mcp.json` default discovery. HTTP entries accept Codex's `type` aliases (`http`, `streamable_http`, and `streamable-http`) and resolve `bearer_token_env_var` at connection time without persisting or projecting the value. OAuth fields (`oauth` and `oauth_resource`) are rejected clearly because the local MCP client has no interactive OAuth provider. Per-tool policy keys are raw MCP names; policy matching uses the bridge's `publicToolName` normalization, including punctuation, long names, and `__`. Changing enablement or approval for an undeclared server rejects before persistence.

Imported hook documents are validated with the [Codex bridge parser](../../hooks/hooks-codex/README.md) before installation and trust. Invalid regex matchers and documents with no supported synchronous command hooks reject; trust cannot make an unsupported document executable.

On Windows, imported hook commands translate `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`, and their `CLAUDE_` aliases into PowerShell environment references. Paths stay in the process environment rather than being inserted as shell code. Other shell syntax remains the bundle author's responsibility.

## Model Experience

### Imported plugin skills

#### What the model sees

When enabled, each declared skill is available to `@hydra/harness-tool-skill` under a source-qualified provider and collision-free name. Search exposes frontmatter-derived metadata, and exact loading reads the instruction body without mutating its source file.

#### Token effect

Skill search and loaded instruction content are data-dependent and are retained in subsequent requests until compaction; enabling a plugin adds no automatic roster text.

#### KV Cache effect

Prefix-stable while the enabled skill candidates and loaded definitions are unchanged. Enabling, disabling, upgrading, or unloading a plugin changes the candidate set and may invalidate reuse from the first changed definition.

### Imported MCP tools

#### What the model sees

Enabled MCP servers publish host-qualified tools named `mcp__<server>__<tool>` with the server description and input schema. Tool calls retain the MCP result mapping owned by `@hydra/harness-mcp-client`; hook context may add further messages.

#### Token effect

Each live tool schema has a fixed per-request cost, while tool arguments, results, and hook context are data-dependent until compaction. Per-tool approval can deny or pause execution before the server runs.

#### KV Cache effect

Prefix-stable while the live MCP tool set and schemas are unchanged. Server startup, failure, reconnect, or disposal can replace definitions and invalidate reuse after the first changed schema; approval policy changes do not change visible schemas.

## Known Limitations and Deferred Work

- **No rollback selector** — prior versions remain cached for rollback, but the command and Settings surfaces currently activate only the imported version and expose no version picker.
- **Hook review is explicit but non-interactive** — `trust` records the digest presented by the current definition; a richer per-hook review UI is deferred.
- **MCP authentication projection is coarse** — stdio is `not-applicable` and remote servers are `unknown`; bearer-token environment references work at connection time but OAuth metadata and detailed auth state are not projected into Settings.
- **Codex and Claude surface coverage is partial** — Hydra discovers Codex and Claude TOML or Markdown command files, Claude’s root `SKILL.md` form, OpenAI `agents/openai.yaml` presentation and invocation policy, and seven synchronous hook events. Custom `agents/*.md` execution, the remaining Codex hook events, the native skill catalog, executable app/interface runtime, Claude settings/LSP/monitor/dependency/bin/output-style/theme components, custom manifest command paths, and marketplace daily sync, policy, upgrade, and rollback flows remain outside this importer. Unsupported Claude fields and components are rejected during import instead of being silently ignored.
- **Plugin code is data-only** — executable files in a bundle are never run directly; capability code must be reached through declared hooks or MCP servers.
