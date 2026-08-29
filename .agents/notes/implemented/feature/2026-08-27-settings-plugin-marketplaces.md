# Agent Note: Settings plugin marketplaces

Status: implemented

## Problem

The Plugins Settings page could inspect and toggle plugins already in the active BH profile, but adding another plugin still required leaving the app and running the CLI. A familiar marketplace workflow was useful as a user-interface model, but adopting another product's private plugin format or accepting arbitrary package specs from a browser would bypass BH's own profile and trust boundaries.

## Decision

The loopback Plugins Settings surface includes a **Marketplace** tab beside **Plugin list**. It can add a GitHub repository, HTTPS or SSH Git URL, or local folder with an optional Git ref and sparse checkout paths; show the catalog's plugins; confirm the exact source and package version; install one plugin; and tell the user to restart BH. Codex and ChatGPT are visual and interaction references only; BH owns the catalog, Remote, profile, and security contracts.

`pluginInventory` stores at most 20 normalized source descriptors in the shared `plugin-marketplaces` setting. Re-adding one source replaces its ref and sparse paths. A local folder is resolved to its real path and read directly without following a link-shaped marketplace document. Git sources are shallow-cloned one at a time into private temporary directories for every read with a root-only sparse checkout by default; optional repository-relative paths of at most 512 characters extend the cone, and an optional concrete ref is fetched and checked out detached. Each checkout is always removed after parsing. Git runs without a shell, disables `ext` and `file` transports, drops environment variables whose names contain `KEY`, `SECRET`, `TOKEN`, or `PASSWORD`, and has a 30-second limit per command. The source root's regular `marketplace.json` file and Git output are bounded to 1 MiB. The strict JSON document contains a name and at most 500 plugins with unique catalog ids, display metadata, an npm registry package name, and an exact SemVer version. One unavailable source stays visible without hiding other catalogs.

The browser never chooses the package spec directly. The Host projects an opaque id derived from the catalog id, package name, and version. After the user acknowledges the risk, `installMarketplacePlugin` finds the persisted descriptor by its Host-projected source, reloads it, and accepts only an entry whose current opaque id matches the reviewed value. This binds installation to the package and exact version shown in the confirmation even when a catalog or Git ref changes between listing and installation.

The Host invokes the current `bh plugin` entry without a shell. Source launches retain only the required Node `--import` hook, built launches inherit no development flags, and Electron launches set `ELECTRON_RUN_AS_NODE=1`. Installation uses `add --save-exact --ignore-scripts`; the installed dependency must declare `bh.bundle` and join the managed active profile. Failure restores `package.json` and the prior presence and bytes of `pnpm-lock.yaml`, reconciles installed dependencies with `install --ignore-scripts`, and restores both files again. A new bundle activates only after restart. If its package name is already a profile bundle, V1 reports **Installed** and does not offer or perform an update.

The connection Host pins inventory reads, enablement, catalog management, and installation to loopback before Typert interceptor selection. The Client registers the Marketplace tab only when `ctx.connection.isLoopback` is true. This is a local configuration plane, not a remotely served administration interface.

## Alternatives considered

**Copy the Codex or ChatGPT marketplace implementation and manifest.** Rejected because those products are UX references, not a BH runtime contract. A small BH-owned JSON catalog maps directly to the existing npm-backed profile model.

**Keep direct marketplace JSON URLs.** Rejected because repository and local-root sources carry the provenance fields users need and align the add flow with the chosen interaction model. BH still reads one bounded `marketplace.json` from the source root instead of adopting another plugin manifest.

**Let the browser submit any npm, Git, or filesystem package spec.** Rejected because the confirmation could diverge from what the Host installs and non-registry packages introduce build-script and provenance concerns. V1 resolves only an exact registry package from a persisted, revalidated catalog.

**Run lifecycle scripts or hot-load the plugin.** Rejected because third-party install scripts execute outside the agent sandbox and hot activation would add Loader rollback and dependency-order semantics. V1 disables scripts and requires an explicit restart.

**Build removal, updates, signing, and authenticated catalogs now.** Rejected because none is necessary for the requested add-and-install path. They require separate state, trust, and rollback decisions rather than speculative controls in this first version.

## Consequences

A local user can add a trusted Git or local marketplace and install its exact advertised BH bundle directly in Settings, using the same profile and package manager semantics as the CLI. Catalog changes after confirmation fail closed, one broken source does not hide healthy sources, and an invalid or non-bundle package does not remain recorded in the profile files.

The user must still decide whether to trust a catalog and package; V1 provides acknowledgement and strict bounds, not signatures or publisher identity. Listing a Git source performs a fresh shallow clone rather than owning cache invalidation or upgrade state. Sources and installed packages cannot be removed in-app, installed versions cannot be updated, lifecycle-script-dependent packages are unsupported, and a restart is required. Focused Host tests pin source/ref/path normalization, Git process isolation, schema/file limits, exact package resolution, stale confirmation rejection, source/built/Electron invocation, installed-by-package behavior, and rollback. Client and composed-web tests pin the three-field add form, loopback-only registration, add and install errors, risk acknowledgement, installed state, and restart notice; the connection test pins the loopback Remote fence.
