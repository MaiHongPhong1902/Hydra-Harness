# Imported plugin runtime

`@bosch/bh-plugin-runtime` mounts the shared `ctx.importedPlugins` service in `bh-base`. It imports an OpenAI/Codex bundle whose root contains `.codex-plugin/plugin.json` from a local folder, Git repository, or marketplace root. Marketplace import accepts `.agents/plugins/marketplace.json`, the legacy root `marketplace.json`, and standard Git-subdirectory entries; direct plugin imports do not need a catalog.

The importer validates the manifest, declared component paths, package/file bounds, and the complete filesystem tree before and after staging. It rejects absolute paths, traversal, links, and junction escapes. Installed code is immutable at `$BH_HOME/plugins/cache/<source-id>/<plugin-name>/<version>/`; writable state is `$BH_HOME/plugins/data/<source-id>/<plugin-name>/`. Every record keeps a source-qualified identity (`<plugin-name>@<source-id>`) and installed versions.

Enabling a record discovers `skills/<skill-name>/SKILL.md` files, root `commands/<command-name>.toml` declarations, and declared MCP servers. A unique imported skill also receives its frontmatter name as a short slash alias; a native/canonical or competing imported name keeps precedence. A command TOML requires non-empty `description` and `prompt` strings; invoking it creates a logged follow-up from its prompt with `{{args}}` and `$ARGUMENTS` replaced by the trimmed input. Native and earlier command names keep precedence. MCP definitions may be inline or loaded from `.mcp.json`; direct maps and `mcp_servers`/`mcpServers` wrappers are accepted, and stdio `cwd` values stay inside `PLUGIN_ROOT`. MCP server enablement, default tool approval, and per-tool approval are independent state. Disabling unloads skills, commands, hooks, MCP processes, and tools deterministically.

Hooks default to `hooks/hooks.json`; a manifest `hooks` value overrides it and may contain paths or inline definitions. Discovery never trusts hooks. Trust is stored against the current hook-definition digest, so an upgrade or edit returns the hook to pending review. Trusted hook processes receive `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, and `CLAUDE_PLUGIN_DATA`. `.app.json` is parsed as inert app/MCP mapping metadata; it never executes.

The `/plugin` command manages these imported bundles (`list`, `import`, `info`, `enable`, `disable`, `trust`, `untrust`, and `remove`). The native `bh plugin` CLI and its marketplace continue to manage BH package bundles; this runtime is the compatibility path for OpenAI/Codex bundles. The Web Marketplace tab exposes the same source, version, lifecycle, skill, MCP, hook, app, and data projections through the Host inventory Remote.

## Model Experience

### Imported plugin skills

#### What the model sees

When enabled, each declared skill is available to `bh-tool-skill` under a source-qualified provider and collision-free name. Search exposes frontmatter-derived metadata, and exact loading reads the instruction body without mutating its source file.

#### Token effect

Skill search and loaded instruction content are data-dependent and are retained in subsequent requests until compaction; enabling a plugin adds no automatic roster text.

#### KV Cache effect

Prefix-stable while the enabled skill candidates and loaded definitions are unchanged. Enabling, disabling, upgrading, or unloading a plugin changes the candidate set and may invalidate reuse from the first changed definition.

### Imported MCP tools

#### What the model sees

Enabled MCP servers publish host-qualified tools named `mcp__<server>__<tool>` with the server description and input schema. Tool calls retain the MCP result mapping owned by `bh-mcp-client`; hook context may add further messages.

#### Token effect

Each live tool schema has a fixed per-request cost, while tool arguments, results, and hook context are data-dependent until compaction. Per-tool approval can deny or pause execution before the server runs.

#### KV Cache effect

Prefix-stable while the live MCP tool set and schemas are unchanged. Server startup, failure, reconnect, or disposal can replace definitions and invalidate reuse after the first changed schema; approval policy changes do not change visible schemas.

## Known Limitations and Deferred Work

- **No rollback selector** — prior versions remain cached for rollback, but the command and Settings surfaces currently activate only the imported version and expose no version picker.
- **Hook review is explicit but non-interactive** — `trust` records the digest presented by the current definition; a richer per-hook review UI is deferred.
- **MCP authentication projection is coarse** — stdio is `not-applicable` and remote servers are `unknown`; credential flows remain owned by the MCP transport.
- **Plugin code is data-only** — executable files in a bundle are never run directly; capability code must be reached through declared hooks or MCP servers.
