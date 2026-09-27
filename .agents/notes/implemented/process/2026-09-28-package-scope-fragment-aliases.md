# Agent Note: Package catalog product fragments

Status: implemented

## Problem

Generated catalog sections use package-derived fragments, while the product name stays `hydraharness` after the npm scope migration.

## Decision

Generated tool and configuration catalogs emit `hydraharness` package anchors even though headings and package names use the published `@hydra1902` scope. The `hydraPackageSlug` helper owns the mapping, and both catalog generators call it when rendering package sections.

## Consequences

Existing package-section links continue to resolve under the product name, and new catalog entries receive the same behavior without hand-editing generated Markdown.

## Alternatives considered

Using the npm scope in fragments would expose an implementation rename in public product links and break the established `hydraharness` anchors.

## Verification

`verify-md-links`, `verify-type-equiv`, the documentation typecheck, and the focused documentation-site tests pass.
