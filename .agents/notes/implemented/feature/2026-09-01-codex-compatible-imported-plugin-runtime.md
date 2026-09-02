# Agent Note: OpenAI/Codex-compatible imported plugin runtime

Status: implemented

## Problem

BH's marketplace installed native package bundles into a profile, while OpenAI/Codex plugins package skills, MCP servers, hooks, app mappings, and assets as an immutable filesystem bundle. Treating an imported bundle as a native package would mix its code and writable state with the profile dependency graph, collapse duplicate names from different sources, and make hook consent indistinguishable from enabling non-hook capabilities.

## Decision

`@bosch/bh-plugin-runtime` is mounted by `bh-base` and exposes `ctx.importedPlugins` to every profile. It accepts local, Git, and OpenAI/Codex marketplace sources; direct imports create source records instead of bypassing the registry. Each plugin has the source-qualified identity `<plugin-name>@<source-id>`, an immutable versioned cache path, and a separate persistent data path.

The runtime validates the plugin manifest and every declared bundle path before and after staging, rejects links and escapes, and retains installed versions. It loads skills, root `commands/*.toml` declarations, and MCP servers only for enabled plugins. A uniquely claimed imported skill receives its standard frontmatter name as an alias, while canonical and competing names keep precedence. Command prompts enqueue logged plugin-sourced follow-ups, not synthetic slash gestures; `{{args}}` and `$ARGUMENTS` receive trimmed command input. It injects plugin root/data environment variables into trusted hook processes, and destroys owned skill registrations, command registrations, hook fibers, MCP fibers, and MCP tools on disable or removal. `.app.json` remains parsed metadata, never executable input.

Plugin enablement, hook-digest trust, MCP-server enablement, MCP authentication state, default MCP tool approval, and per-tool approval are separate durable state. Hook definitions require review after their digest changes; enabling a plugin does not trust a hook or approve an MCP tool. The `/plugin` command and loopback Marketplace UI manage imported bundles without changing the native `bh plugin` CLI contract.

## Alternatives considered

**Install OpenAI/Codex bundles through `bh plugin`.** Rejected because native packages participate in the profile dependency graph and execute under a different package lifecycle; bundles need immutable staged files, source-qualified identity, and independent writable data.

**Use plugin enablement as the trust decision.** Rejected because skill discovery and MCP availability do not authorize hook execution or individual MCP tool calls.

**Use an unqualified plugin name as the registry key.** Rejected because identical plugin names from independent Git, local, or marketplace sources must coexist and retain their own upgrades and data.

## Consequences

Every BH profile can load an unmodified OpenAI/Codex plugin while preserving native BH marketplace behavior. A plugin upgrade retains prior bundle versions and requires hook re-review only when the hook definition changes. The runtime fixture suite covers staged immutable versions, path and link rejection, marketplace forms, MCP map forms and working directories, duplicate names, hook re-trust, skill/command disposal, command collisions and interpolation, and failed MCP startup teardown; Host inventory, Marketplace UI, and loopback Remote-fence checks cover the integrated controls.

The runtime intentionally does not execute arbitrary bundle code or install package dependencies. It reaches local behavior only through declared MCP processes and reviewed hook definitions. Rollback selection, per-hook review UI, and remote MCP authentication flows remain outside this first lifecycle owner.
