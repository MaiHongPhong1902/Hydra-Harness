# Agent Note: Capability-first user home

Status: implemented

## Problem

The published documentation home redirected immediately to the quickstart, so the GitHub Pages entry point did not explain the runtime's available interfaces, tools, context, controls, or extension model.

## Decision

The documentation home is a canonical capability overview in `docs/user/index.md`. It presents the Web UI, desktop, CLI, ACP, JSON-RPC, and Python entry points, then groups shipped behavior into project work, browser and web access, durable context, coordination, access control, and plugin extension. The page links to the existing user and developer documentation and keeps npm and source launch commands beside the feature overview.

## Alternatives considered

**Keep the redirect and expand the quickstart:** rejected because a quickstart is an onboarding sequence, not a stable inventory of the product surface.

**Create a website-only landing page:** rejected because the user-facing overview must remain available in the repository and GitHub-rendered Markdown as the canonical source.

## Consequences

The GitHub Pages home now describes the current Hydra capability surface without duplicating subsystem reference pages. New user-visible capabilities should update this overview or link to their owning guide when the capability becomes available.
