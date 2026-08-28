# @bosch/bh-client-ui-settings-plugin-inventory

The plugin-management tabs for Web Settings. The browser plugin always registers the localized **Plugin list** contribution with id `all`. On a loopback page it also registers **Marketplace** with id `marketplace`; non-loopback clients do not receive the installation surface. The Plugins section owns the navigation entry and tab chrome. Registration performs no Remote read, and selecting a tab mounts it and lazily reads its Host-owned snapshot through [`api-remotes`](../../api/remotes/README.md).

The tab renders a searchable two-column catalog of compact disclosure cards. Each collapsed card uses the short module name as its title and a small effective-enablement tag; enabled entries also show a colored root-fiber status dot. Expanding one card reveals its Loader-tree entry id, effective configuration, Cordis status, and an Enable or Disable button when the Host marks the entry toggleable. A protected built-in entry explains that it cannot be disabled instead of offering a switch. Mutations remain disabled while one request is pending, replace the visible snapshot only with the Host response, and expose a localized generic error without transport details. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

The Marketplace tab adds a catalog URL in a modal, keeps unavailable sources visible, and renders the Host-validated package name and exact version for each entry. Install opens a risk confirmation naming the exact source and package spec. Success replaces the catalog with the returned snapshot and shows a restart-required notice; installed package names display as **Installed** instead of offering an update. The Host remains authoritative for URL/schema validation, package resolution, installation, and rollback.

## Model Experience

None, as this package only visualizes a Host-owned deployment snapshot in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One snapshot per Settings mount, retry, or mutation** — neither tab subscribes to Loader or marketplace changes or automatically refetches after reconnect; switching tabs preserves the current snapshot, while reopening Settings obtains a new one.
- **Install-only marketplace V1** — the UI does not remove sources, remove or update installed plugins, accept Git/path specs, or hot-load a newly installed bundle.
- **No catalog search yet** — search applies to the Plugin list; marketplace entries are grouped by their configured source without a separate filter.
