# Agent Note: Publish from the default branch

Status: implemented

## Problem

The repository default branch is `main`, while the release pack trigger and documentation source links still referred to `master`. A normal main push therefore skipped the release pack workflow and published source links to a branch that does not exist.

## Decision

The Hydra release pack workflow listens to `main`, and the documentation deployment listens to `main` as well as manual dispatch while using `main` for projected repository links. The Pages checkout includes PageAgent submodules so package-path verification sees the same tree as a developer checkout. Release publication remains an explicit `hydra-v*` tag dispatch, so pushing the default branch publishes documentation but not packages.

## Alternatives considered

**Rename the default branch to `master`:** rejected because the repository and existing CI already use `main`.

**Follow the release tag for documentation links:** rejected because a released site should link to the public default branch for current source navigation.

## Consequences

Main pushes now exercise the release packing path and publish the documentation site, and documentation links resolve against the public repository. The Pages gate also validates submodule-owned package references. Package publication still requires its explicit workflow and release tag.
