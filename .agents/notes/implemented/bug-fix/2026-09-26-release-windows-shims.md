# Agent Note: Resolve release command shims on Windows

Status: implemented

## Problem

The release helpers invoked `pnpm` and `npm` with `spawnSync` without shell resolution. On Windows the package manager shims are not native executables, so local release packing failed with `spawnSync pnpm ENOENT` after the official build had succeeded.

## Decision

The shared release process helper enables Windows shell resolution for its fixed internal release commands while preserving inherited or captured streams and the existing arguments. Unix release execution remains shell-free.

## Alternatives considered

**Hardcode `pnpm.cmd` and `npm.cmd` at each call site:** rejected because it duplicates platform selection and misses future release commands.

**Require a globally installed native executable:** rejected because the repository already supports the package-manager shims supplied by the supported Node and pnpm setup.

## Consequences

The same release verify, pack, install verification, and publish helpers can run from Windows and Unix runners. Release command names and arguments remain owned by the release scripts.
