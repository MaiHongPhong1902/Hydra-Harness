# Agent Note: Native Playwright control for embedded browser tabs

Status: implemented

## Problem

Hydra's browser actions used PageController DOM helpers for ordinary clicks and form operations. That path did not provide Playwright actionability, locator waiting, or native drag and hover semantics.

## Decision

The Electron controller connects `playwright-core` directly to each controlled tab's existing Electron debugger through an in-process CDP transport. Indexed accessibility refs use Playwright locators, while named actions use accessible labels, roles, and placeholders. Navigation policy, tab ownership, snapshots, uploads, and raw CDP approval remain owned by Hydra.

## Alternatives considered

**Run Playwright MCP as a child server.** Rejected because it adds a second browser owner and loses Hydra's tab, policy, and session ownership.

**Expose a TCP remote-debugging port.** Rejected because the transport would widen the browser control surface and require port lifecycle management.

**Keep PageController for every action.** Rejected because it lacks Playwright's actionability and locator semantics for user-like interaction.

## Consequences

The browser package owns one Playwright dependency and a bounded transport adapter. Playwright action failures propagate through the existing browser error path. Accessibility snapshots remain Hydra projections and PageAgent remains an explicit fallback.

## Testing

`node --check` covers both Electron JavaScript modules. The existing Electron interaction suite exercises the same click, drag, named-field, select, and navigation paths; it was not run in this change because the user requested no tests.

## Deferred

Playwright locator diagnostics and regex snippet output for `browser_find` remain Hydra-owned presentation work; add them when model-visible find results need the full MCP diagnostic payload.
