# @bosch/bh-host-plugin-inventory

`PluginInventoryGateway` projects the current Cordis Loader tree, persistent module enablement, imported OpenAI/Codex bundle lifecycle, and OpenAI/Codex marketplace sources through `pluginInventory` Remotes. It publishes `list`, `setEnabled`, `listMarketplaces`, `addMarketplace`, `removeMarketplace`, `listImportedPlugins`, `importPlugin`, `infoPlugin`, `enablePlugin`, `disablePlugin`, `setPluginMcpServerEnabled`, `trustPlugin`, `untrustPlugin`, and `removePlugin`.

Loader inventory reads `ctx.loader.entries()` directly, skips structural group rows and configured `compositionEntryIds`, and projects one logical module with its configured entry id, module name, effective enablement, toggle eligibility, and root Fiber phase. `setEnabled` updates the configured entry, disables physical duplicates, persists by module name in `plugins.enabled`, and restores the Loader state if persistence fails.

## OpenAI/Codex marketplace sources

`plugin-marketplaces.sources` stores a normalized source, optional Git ref, and repository-relative sparse paths. Sources are GitHub shorthand, HTTPS/SSH Git URLs, or existing local folders. A source must contain `.agents/plugins/marketplace.json` or root `marketplace.json` with a `plugins` array. The catalog is validation-only here; `importPlugin` selects and stages a bundle through `@bosch/bh-plugin-runtime`, which validates the bundle manifest and controls its lifecycle.

Git reads use a temporary shallow clone, enable sparse checkout only when paths are supplied, always retain the catalog path, reject unsafe transports and credential-like environment variables, apply a 30-second command timeout, and remove the checkout after parsing. Local catalog files and Git output are capped at 1 MiB. At most 20 sources and 500 catalog entries are accepted. `removeMarketplace` changes source configuration only and never removes an imported bundle.

## Model Experience

None, as this Host projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No marketplace-entry projection** — the gateway validates sources but does not expose catalog metadata; import with a selected plugin name is owned by the imported-plugin runtime.
