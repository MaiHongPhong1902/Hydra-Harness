# Agent Note: OpenAI/Codex-compatible imported plugin runtime

Status: implemented

## Problem

Hydra harness's marketplace installed native package bundles into a profile, while OpenAI/Codex plugins package skills, MCP servers, hooks, app mappings, and assets as an immutable filesystem bundle. Treating an imported bundle as a native package would mix its code and writable state with the profile dependency graph, collapse duplicate names from different sources, and make hook consent indistinguishable from enabling non-hook capabilities.

## Decision

`@hydra/harness-plugin-runtime` is mounted by `@hydra/harness-base` and exposes `ctx.importedPlugins` to every profile. It accepts local, Git, and OpenAI/Codex marketplace sources; direct imports create source records instead of bypassing the registry. Each plugin has the source-qualified identity `<plugin-name>@<source-id>`, an immutable versioned cache path, and a separate persistent data path. [Unique imported plugin names](../simplification/2026-09-03-unique-imported-plugin-names.md) later prevents concurrent installed records with the same manifest name while retaining source-qualified identity for same-source upgrades and owned paths.

The runtime validates the plugin manifest and every declared bundle path before and after staging, rejects links and escapes, and retains installed versions. It loads skills, root `commands/*.toml` declarations, and MCP servers only for enabled plugins. A uniquely claimed imported skill receives its standard frontmatter name as an alias, while canonical and competing names keep precedence. Command prompts enqueue logged plugin-sourced follow-ups, not synthetic slash gestures; `{{args}}` and `$ARGUMENTS` receive trimmed command input. It injects plugin root/data environment variables into trusted hook processes, and destroys owned skill registrations, command registrations, hook fibers, MCP fibers, and MCP tools on disable or removal. `.app.json` remains parsed metadata, never executable input.

Plugin enablement, hook-digest trust, MCP-server enablement, MCP authentication state, default MCP tool approval, and per-tool approval are separate durable state. Hook definitions require review after their digest changes; enabling a plugin does not trust a hook or approve an MCP tool. The `/plugin` command and loopback Marketplace UI manage imported bundles without changing the native `hydra plugin` CLI contract. Catalog chat verbs (`marketplace add|list|remove` and `install`) are recorded in [`/plugin marketplace` and `/plugin install` slash verbs](2026-09-04-plugin-marketplace-slash-verbs.md).

Containment compares the native realpath of both the root and the selected file. A Git checkout under a Windows short-name or aliased temporary parent is still inside its root; comparing its canonical descendant against the unexpanded root falsely rejects it. An aliased-temp Git-subdirectory fixture pins this behavior alongside the existing traversal and bundle-link rejection tests.

## Alternatives considered

**Install OpenAI/Codex bundles through `hydra plugin`.** Rejected because native packages participate in the profile dependency graph and execute under a different package lifecycle; bundles need immutable staged files, source-qualified identity, and independent writable data.

**Use plugin enablement as the trust decision.** Rejected because skill discovery and MCP availability do not authorize hook execution or individual MCP tool calls.

**Use an unqualified plugin name as the registry key.** Rejected because source qualification still gives same-source upgrades and owned paths a stable identity; installed-name uniqueness is enforced separately.

## Consequences

[Hook and MCP loading, ownership, and approval](../bug-fix/2026-09-06-hook-mcp-loading-and-ownership.md) defines Host-owned component effects, settled MCP activation, normalized policy matching, and executable hook validation.

Every Hydra profile can load an unmodified OpenAI/Codex plugin while preserving native Hydra marketplace behavior. A plugin upgrade retains prior bundle versions and requires hook re-review only when the hook definition changes. The runtime fixture suite covers staged immutable versions, path and link rejection, marketplace forms, MCP map forms and working directories, duplicate-name rejection and removal, hook re-trust, skill/command disposal, command collisions and interpolation, and failed MCP startup teardown; Host inventory, Marketplace UI, and loopback Remote-fence checks cover the integrated controls.

The runtime intentionally does not execute arbitrary bundle code or install package dependencies. It reaches local behavior only through declared MCP processes and reviewed hook definitions. Rollback selection, per-hook review UI, and remote MCP authentication flows remain outside this first lifecycle owner.

[Imported skill metadata and conservative routing](../bug-fix/2026-09-06-imported-skill-policy-and-routing.md) owns shared YAML parsing, invocation-policy preservation, and alias deduplication. Those corrections retain the installed-bundle lifecycle and independent trust decisions described here.
