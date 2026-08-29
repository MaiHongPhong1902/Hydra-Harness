# @bosch/bh-host-plugin-inventory

Host projection, persistent enablement controller, and local marketplace installer for the current Cordis Loader tree. `PluginInventoryGateway` registers the `pluginInventory` service and publishes the generated direct Remotes `pluginInventory/list`, `pluginInventory/setEnabled`, `pluginInventory/listMarketplaces`, `pluginInventory/addMarketplace`, and `pluginInventory/installMarketplacePlugin`. Every inventory read uses `ctx.loader.entries()` directly, skips structural group rows and configured `compositionEntryIds`, and returns one logical row per remaining module with its configured Loader entry id, module specifier, effective enablement, toggle eligibility, and current root Fiber phase.

The phase is `pending`, `loading`, `active`, `failed`, or `unloading`; it is `null` when the logical module is disabled or has no live root Fiber. Loader remains the lifecycle authority while the shared `plugins.enabled` section in `$BH_HOME/settings.yaml` is the user-setting authority for both Web and Desktop. `setEnabled` updates the one configured instance, disables physical duplicates, persists by module name through `ctx.settings`, and rolls the live entries back when persistence fails. HMR stays mounted with no module roots while logically disabled so the settings and profile files remain observable. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Marketplace contract

Marketplace sources are stored in the shared `plugin-marketplaces.sources` setting as a normalized source, optional Git ref, and repository-relative sparse checkout paths. `addMarketplace` accepts GitHub `owner/repo` shorthand, HTTPS or SSH Git URLs, and existing local folders. Remote URLs reject embedded passwords, HTTPS usernames, queries, fragments, and protocols other than HTTPS or SSH; Git refs reject option-like or control-character input, and sparse paths are limited to 512 characters and cannot be absolute or traverse parents. Re-adding the same normalized source replaces its ref and sparse paths.

Each source root contains a regular `marketplace.json` file. Git sources are shallow-cloned one at a time into a private temporary directory for validation and every later read; the default sparse checkout contains only root files, optional paths extend it in cone mode, optional refs are fetched and checked out detached, and the checkout is removed after parsing. Git runs without a shell, disables `ext` and `file` transports, receives no environment variables whose names contain `KEY`, `SECRET`, `TOKEN`, or `PASSWORD`, and has a 30-second limit per command. Local folders are read directly without following a link-shaped marketplace document. Marketplace files and Git output are bounded to 1 MiB. At most 20 sources and 500 entries per document are accepted. A document has this strict shape:

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

Only npm registry package names with an exact SemVer version are installable. The Host reloads the persisted source descriptor at confirmation time and resolves an opaque id bound to the reviewed catalog id, package, and version. It then invokes the current source, built, or Electron-hosted `bh plugin` CLI with `add --save-exact --ignore-scripts`. A dependency must declare a BH bundle and join the active profile; otherwise the package manifest and lockfile are restored and the prior install is reconciled. A successful new install requires a BH restart before the bundle loads. Package-name membership is the V1 installed state, so an already installed package is not updated when a catalog advertises another version.

## Model Experience

None, as this Host-only inventory projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time state only** — the result contains no durable failure history or subscription; a missing root Fiber is reported as `null`, regardless of why no live root exists.
- **Configured switches only** — dynamically created modules without a configured profile entry and configured protected modules remain visible but cannot be changed in-app; composition-owned rows are omitted and remain controlled by their owning agent preset.
- **Fresh temporary Git reads** — listing a Git marketplace performs a shallow clone instead of retaining a checkout; add persistent snapshots only if measured Settings latency justifies cache invalidation and upgrade semantics.
- **Install-only marketplace V1** — sources cannot be removed in-app, and installed plugins cannot be removed or updated. Catalog signing, non-registry package specs, and lifecycle scripts are unsupported.
- **Restart activation** — installation changes the persisted profile only; it does not hot-load the new bundle into the current process.
