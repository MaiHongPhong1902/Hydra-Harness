# Agent Note: Hydra product identity and package namespace

Status: implemented

## Problem

The agent's displayed name and its npm package names need one product identity. Renaming manifests alone leaves imports, Cordis compositions, generated client module ids, release tooling, and consumer fixtures referring to packages the workspace cannot resolve.

## Decision

Repository-owned npm packages use the `@hydraharness` scope. Harness packages use `@hydraharness/harness-<role>`, the CLI package is `@hydraharness/harness`, and the examples workspace is `@hydraharness/harness-examples`. Vendored framework and native launcher packages retain their descriptive names under the same scope. The [vendor rescope decision](../process/2026-08-10-vendor-package-rescope.md) continues to own upstream attribution, version preservation, and synchronization.

Python distributions are `hydra-harness-sdk` and `hydra-harness-runtime-bin`. Their import modules are `hydra_harness` and `hydra_harness_runtime`; the public SDK entry is `HydraHarness`. Wheel staging, CI artifacts, runtime discovery, and examples use the same names. The JSON-RPC `serverInfo.name` remains the wire-stable `hydra-harness-sdk-runtime` identifier.

Manifests, imports, module augmentation targets, TypeScript paths, Cordis plugin references, package-name validators, lockfile entries, and current documentation use these names together. Package directories, public service names, the `hydra` executable, `HYDRA_*` environment variables, Harness home paths, and release-family ids retain their existing meaning. This repository's public home is `https://github.com/MaiHongPhong1902/Hydra-Harness`. Third-party package names, vendored upstream remotes, license attribution, historical issue and pull citations, and archived decision records remain upstream or historical identifiers. Wire `User-Agent` sends the product token `hydra-harness`.

The product, desktop, browser actor, and documentation site display `Hydra harness`. The [supplied artwork](../../../../assets/branding/README.md) owns all product logo derivatives; the generator embeds the same PNG into client bundles and emits the Electron icons, favicons, website wordmark, and badge. The [badge provider decision](../feature/2026-08-06-bundled-hydra-badge-skill.md) retains discovery and lifecycle ownership. The supplied GIF provides hover animation for the client logo and website wordmark. An animated WebP preserves its timing and transparent background; leaving restores the still image. The client primitives package publishes the PNG and WebP resources imported by its logo modules. Explicit pointer hover requests playback even when Windows/Electron reports reduced motion, so the preference does not suppress the requested interaction. Native icons and badges remain static. Remote badge use requires copying or uploading the bundled asset; no public asset URL is assumed.

## Alternatives considered

**Changing only the npm scope** leaves the previous product abbreviation in every harness package name. The `harness-` prefix identifies the package family under Hydra without changing its role suffixes.

**Compatibility package aliases** preserve two package identities and can load duplicate framework services. The pre-release repository instead requires consumers and saved Cordis compositions to use the current package names.

## Consequences

External consumers must update dependency names and imports together; saved profiles and presets containing package specifiers require the same update. Session logs remain historical records. Workspace linking, built application startup, module identity, generated catalogs, and package publication checks verify the rename; source-only compilation cannot prove installed resolution.
