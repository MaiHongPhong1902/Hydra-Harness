# @bosch/bh-client-ui-settings-plugin-inventory

The local Web Settings contribution for OpenAI/Codex plugin bundles. It registers **Plugins**, **Skills**, **Marketplace**, and **Hooks** tabs in the existing Plugins section. Remote clients only receive the Plugins tab with an unavailable message; local controls are loopback-only.

**Plugins** lists native BH deployment plugins together with every imported OpenAI/Codex bundle and its enablement/remove controls: one list of everything the agent can use. Native entries with the same module share one card but retain separate switches for their Host or preset instances. Ordinary Host rows apply live; changed core rows use the warning treatment and keep a sticky restart notice visible; preset rows identify their preset and apply only to new sessions. Imported plugin names are unique across sources, and removing the installed record permits that name to be imported from another source. **Marketplace** only manages sources: it adds, validates, lists, enables/disables, and removes OpenAI/Codex marketplace sources. The add dialog is two steps in one pass: the source is saved first, and then a named plugin is staged into the BH home through the same import call the Plugins tab's list reflects. A blank name saves the source alone; a failed install leaves the source saved, reports the failure as an import result beside the staged name, and its retry re-runs only the import — never re-adding an already-saved source. Toggling a marketplace's slot cascades enable/disable to every plugin imported from it; removing a marketplace uninstalls those plugins. **Skills** lists imported skills. **Hooks** lists imported hook declarations and owns their trust/revoke action. The existing **MCP** tab, contributed by `ui-settings-plugins`, owns imported MCP server enablement and leaves tool approval in the runtime policy.

Marketplace sources accept GitHub shorthand, HTTPS/SSH Git URLs, or local roots. The Host accepts `.agents/plugins/marketplace.json` and root `marketplace.json`. The Settings contribution reads snapshots lazily and only replaces its displayed state with Host operation results.

**Marketplace-owner grouping.** The Plugins, Skills, Hooks, and Marketplace tabs each split their rows into one section per marketplace owner, derived by `marketplace-owner.ts`'s `marketplaceOwnerLabel()`: the path segment right after the domain (`https://github.com/example-labs/toolkit` groups as `example-labs`, containing `Toolkit`). GitHub shorthand and scp-style Git sources resolve the same owner; a local marketplace root, which has no owner, falls back to its own folder name. An imported plugin's group key is its `source.marketplace` when it came from a marketplace, or its own `source.source` otherwise, so directly-imported plugins each get their own single-plugin group.

**Shared search.** `ui-settings-plugins` renders the one search box for the whole Plugins section (see its README); every tab here receives the current text as the `query` owner prop from the `settings.plugins.tab` slot and filters its own rows against plugin/skill/hook/marketplace-source text, independent of which tab is active.

## Model Experience

None, as this package only visualizes Host-owned plugin state and registers no model-facing input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Core plugin state takes effect after restart, and preset plugin state affects only new sessions.
