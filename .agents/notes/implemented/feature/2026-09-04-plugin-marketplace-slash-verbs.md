# Agent Note: `/plugin marketplace` and `/plugin install` slash verbs

Status: implemented

## Problem

Users paste Claude Code / Codex catalog commands such as `/plugin marketplace add example-labs/toolkit` into BH chat. The `/plugin` handler only accepted `list`, `import`, `info`, `enable`, `disable`, `trust`, `untrust`, and `remove`. The unknown `marketplace` verb returned a usage error. Admission still succeeded, the composer cleared the draft, and the long usage string is ellipsized on the command row, so the session looked like the agent did nothing. A second documented command, `/plugin install toolkit@toolkit`, had the same gap. Settings already persisted OpenAI/Codex marketplace sources; the chat command did not call that path.

## Decision

`/plugin marketplace add <source>` persists the source through `pluginInventory.addMarketplace` when that Host service is composed. When inventory is absent, the same verb imports the source through the existing OpenAI/Codex bundle importer so a runtime-only composition still does work. `/plugin marketplace list` and `/plugin marketplace remove` read and delete those persisted sources. `/plugin install` stages a bundle and enables it: an explicit folder, GitHub shorthand, or Git URL imports that source; `name@marketplace` selects a catalog entry, resolving `marketplace` as an explicit source or as the repository name of a persisted source; a bare already-imported name enables that record; a bare name with exactly one persisted marketplace imports that catalog entry.

## Alternatives considered

**Leave `/plugin` unchanged and tell users to use Settings or `/plugin import`.** Rejected because the documented catalog commands are what users type, and the usage-error row is easy to miss.

**Treat `marketplace add` as import-and-enable.** Rejected because Claude Code's add step only records the catalog; install is the enablement step, and BH Settings already separates persisting a source from enabling a bundle.

**Add a peer dependency from plugin-runtime onto plugin-inventory.** Rejected because inventory already depends on the runtime; the command reads `ctx.get('pluginInventory')` and falls back to import when that service is missing.

## Consequences

A chat `/plugin marketplace add example-labs/toolkit` followed by `/plugin install toolkit@toolkit` records the catalog, stages the bundle, and enables it, matching the two-prompt Codex/Claude Code flow. Hook trust remains a separate `/plugin trust` step. Focused runtime command tests pin inventory persistence, the import fallback, name-key marketplace resolution, and enablement.
