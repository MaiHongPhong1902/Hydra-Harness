# @bosch/bh-host-plugin-inventory

Host projection and persistent enablement controller for the current Cordis Loader tree. `PluginInventoryGateway` registers the `pluginInventory` service and publishes the generated direct Remotes `pluginInventory/list` and `pluginInventory/setEnabled`. Every list reads `ctx.loader.entries()` directly, skips structural group rows, and returns the remaining entries in Loader order with their Loader entry id, module specifier, effective enablement, toggle eligibility, and current root Fiber phase.

The phase is `pending`, `loading`, `active`, `failed`, or `unloading`; it is `null` when the entry has no live root Fiber. The snapshot is point-in-time and Loader remains the lifecycle authority. `setEnabled` accepts only root profile entries outside `protectedEntryIds`, applies the change to the live entry, and stores the boolean in an app-owned block inside the profile's `cordis.patch.yml`. The block update preserves user-owned YAML and comments, runs under a cross-process file lock, commits by atomic rename, and rolls the live entry back when persistence fails. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Model Experience

None, as this Host-only inventory projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time state only** — the result contains no durable failure history or subscription; a missing root Fiber is reported as `null`, regardless of why no live root exists.
- **Profile-root switches only** — nested, dynamically created, grouped, and configured protected entries remain visible but cannot be changed in-app. Later home-level or command-line patch layers retain their normal precedence over the profile file.
- **Enablement only** — the service does not add, remove, update, or identify the provenance of plugins.
