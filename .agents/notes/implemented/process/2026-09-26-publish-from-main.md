# Agent Note: Publish from the default branch

Status: implemented

## Problem

The repository default branch is `main`, while the release pack trigger and documentation source links still referred to `master`. A normal main push therefore skipped the release pack workflow and published source links to a branch that does not exist.

## Decision

The Hydra release pack workflow listens to `main`, and the documentation deployment uses `main` for projected repository links. Release publication remains an explicit `hydra-v*` tag dispatch, so pushing the default branch does not publish packages or deploy Pages by itself.

## Alternatives considered

**Rename the default branch to `master`:** rejected because the repository and existing CI already use `main`.

**Follow the release tag for documentation links:** rejected because a released site should link to the public default branch for current source navigation.

## Consequences

Main pushes now exercise the release packing path, and documentation links resolve against the public repository. Package publication and Pages deployment still require their explicit workflows and release tag.
