# Agent Note: Publish the documentation site from main

Status: implemented

## Problem

The documentation site followed a release tag, so documentation committed to the default branch stayed out of date until a release dispatch.

## Decision

`.github/workflows/docs-pages.yml` deploys on pushes to `main` and keeps `workflow_dispatch` for manual reruns. The build validates and projects the checked-out tree directly, without the package release version gate; package publication remains tag-gated in its own workflow. The Pages environment remains `github-pages`, and projected repository links continue to target `main`.

`ci-workflow.spec.ts` pins the two deployment triggers, the absence of the release gate, the shallow checkout, the submodule checkout, and the Pages environment. The earlier tag-only Pages decision is superseded by this note; its release rationale remains relevant to package publication.

## Alternatives considered

**Keep Pages tag-gated:** rejected because the public documentation must track the default branch after merges.

**Deploy every branch or pull request:** rejected because it would publish unmerged or non-default content and add deployment runs that do not represent the public tree.

**Remove manual dispatch:** rejected because maintainers still need a direct rerun after a transient Pages or runner failure.

## Consequences

Every push to `main` can publish the current documentation after `doc-sync` passes, so site content and the public source branch advance together. The site can describe work that is not in a released package; release tags remain the package publication control. The repository's `github-pages` environment must allow the `main` branch in its deployment branch policy for the workflow to deploy.
