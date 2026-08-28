# @bosch/bh-host-plugin-inventory

Host projection, persistent enablement controller, and local marketplace installer for the current Cordis Loader tree. `PluginInventoryGateway` registers the `pluginInventory` service and publishes the generated direct Remotes `pluginInventory/list`, `pluginInventory/setEnabled`, `pluginInventory/listMarketplaces`, `pluginInventory/addMarketplace`, and `pluginInventory/installMarketplacePlugin`. Every inventory read uses `ctx.loader.entries()` directly, skips structural group rows and configured `compositionEntryIds`, and returns one logical row per remaining module with its configured Loader entry id, module specifier, effective enablement, toggle eligibility, and current root Fiber phase.

The phase is `pending`, `loading`, `active`, `failed`, or `unloading`; it is `null` when the logical module is disabled or has no live root Fiber. Loader remains the lifecycle authority while the shared `plugins.enabled` section in `$BH_HOME/settings.yaml` is the user-setting authority for both Web and Desktop. `setEnabled` updates the one configured instance, disables physical duplicates, persists by module name through `ctx.settings`, and rolls the live entries back when persistence fails. HMR stays mounted with no module roots while logically disabled so the settings and profile files remain observable. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Marketplace contract

Marketplace sources are stored in the shared `plugin-marketplaces.sources` setting. `addMarketplace` accepts HTTPS document URLs and loopback HTTP URLs for local development, rejects credentials, fragments, redirects, and documents over 1 MiB, and times out after 10 seconds. At most 20 sources and 500 entries per document are accepted. A document has this strict shape:

```json
{
  "name": "Example marketplace",
  "plugins": [
    {
      "id": "example-plugin",
      "name": "Example plugin",
      "description": "Adds one example capability.",
      "package": "@example/bh-plugin",
      "version": "1.2.3"
    }
  ]
}
```

Only npm registry package names with an exact SemVer version are installable. The Host refetches the persisted source at confirmation time and resolves an opaque id bound to the reviewed catalog id, package, and version. It then invokes the current source, built, or Electron-hosted `bh plugin` CLI with `add --save-exact --ignore-scripts`. A dependency must declare a BH bundle and join the active profile; otherwise the package manifest and lockfile are restored and the prior install is reconciled. A successful new install requires a BH restart before the bundle loads. Package-name membership is the V1 installed state, so an already installed package is not updated when a catalog advertises another version.

## Model Experience

None, as this Host-only inventory projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time state only** — the result contains no durable failure history or subscription; a missing root Fiber is reported as `null`, regardless of why no live root exists.
- **Configured switches only** — dynamically created modules without a configured profile entry and configured protected modules remain visible but cannot be changed in-app; composition-owned rows are omitted and remain controlled by their owning agent preset.
- **Install-only marketplace V1** — sources cannot be removed in-app, and installed plugins cannot be removed or updated. Catalog signing, authenticated catalogs, Git/path package specs, and lifecycle scripts are unsupported.
- **Restart activation** — installation changes the persisted profile only; it does not hot-load the new bundle into the current process.
