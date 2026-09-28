# Agent Note: Canonicalize linked package roots in the profile fallback

Status: implemented

## Problem

`healProfilesModuleFallback` followed a package dependency from the lexical path used to reach a junction. Dependencies installed beside the physical package were absent from the search paths, and pnpm's relative links inside that package could fail through the junction on Windows. This omitted packages such as `@hydraharness/harness-client-file-upload` and caused the Desktop Host to fail with `ERR_MODULE_NOT_FOUND`.

## Decision

The profile resolver returns `realpathSync(candidate)` after locating each package. Dependency scans therefore continue from the package's physical directory, preserving relative links while keeping the existing two-anchor resolution and flat fallback owned by the [profile plugin bundles decision](../architecture/2026-08-05-profile-plugin-bundles.md). The [fallback unlink decision](2026-08-12-unlink-stale-profile-fallback-links.md) continues to govern replacement of stale links.

## Alternatives considered

**Add one profile junction per missing package.** This repairs one checkout and leaves other linked installations vulnerable.

**Rewrite pnpm's links.** This makes Hydra own generated dependency state outside its profile directory. Canonicalizing the resolved package root fixes the shared resolver with one filesystem operation.

## Consequences

Linked bundles expose dependencies from their physical directories to profiles. Existing real directories still fail loudly when they occupy a fallback link, and unresolved declared packages remain skipped.

## Testing

`packages/boot/app-boot/tests/profile.spec.ts` verifies that a profile can import a dependency installed beside a junction-linked bundle. The regression fails with `MODULE_NOT_FOUND` without canonicalization. Native Desktop smoke verifies Host readiness and the assembled Files, Terminal, and Browser surfaces.
