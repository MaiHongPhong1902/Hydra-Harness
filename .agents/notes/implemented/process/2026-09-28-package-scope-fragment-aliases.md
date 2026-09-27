# Agent Note: Package catalog fragment compatibility

Status: implemented

## Problem

Generated catalog sections use package-derived fragments, while repository links can retain the earlier package scope spelling.

## Decision

Generated tool and configuration catalogs emit the canonical `@hydra1902` package anchor and a compatibility anchor for the `@hydra` package spelling. Package READMEs and guides can keep either fragment while headings and package names use the published scope. The `legacyHydraPackageSlug` helper owns the mapping, and both catalog generators call it when rendering package sections.

## Consequences

Existing package-section links continue to resolve, and new catalog entries receive the same compatibility behavior without hand-editing generated Markdown.

## Alternatives considered

Updating every existing link would create a large documentation-only diff and would not preserve links held outside the repository. Emitting only the current fragment would leave those links broken.

## Verification

`verify-md-links`, `verify-type-equiv`, the documentation typecheck, and the focused documentation-site tests pass.
