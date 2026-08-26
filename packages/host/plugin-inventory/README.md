# @bosch/bh-host-plugin-inventory

Host projection and persistent enablement controller for the current Cordis Loader tree. `PluginInventoryGateway` registers the `pluginInventory` service and publishes the generated direct Remotes `pluginInventory/list` and `pluginInventory/setEnabled`. Every list reads `ctx.loader.entries()` directly, skips structural group rows, and returns one logical row per module with its configured Loader entry id, module specifier, effective enablement, toggle eligibility, and current root Fiber phase.

The phase is `pending`, `loading`, `active`, `failed`, or `unloading`; it is `null` when the logical module is disabled or has no live root Fiber. Loader remains the lifecycle authority while the shared `plugins.enabled` section in `$BH_HOME/settings.yaml` is the user-setting authority for both Web and Desktop. `setEnabled` updates the one configured instance, disables physical duplicates, persists by module name through `ctx.settings`, and rolls the live entries back when persistence fails. HMR stays mounted with no module roots while logically disabled so the settings and profile files remain observable. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Model Experience

None, as this Host-only inventory projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time state only** — the result contains no durable failure history or subscription; a missing root Fiber is reported as `null`, regardless of why no live root exists.
- **Configured switches only** — dynamically created modules without a configured profile entry and configured protected modules remain visible but cannot be changed in-app.
- **Enablement only** — the service does not add, remove, update, or identify the provenance of plugins.
