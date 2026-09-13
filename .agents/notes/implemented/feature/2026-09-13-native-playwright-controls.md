# Agent Note: Native Playwright control for embedded browser tabs

Status: implemented

## Problem

Hydra's browser actions used PageController DOM helpers for ordinary clicks and form operations. That path did not provide Playwright actionability, locator waiting, or native drag and hover semantics.

## Decision

The Electron controller connects `playwright-core` directly to each controlled tab's existing Electron debugger through an in-process CDP transport. Indexed accessibility refs use Playwright locators, while named actions use accessible labels, roles, and placeholders. Navigation policy, tab ownership, snapshots, uploads, and raw CDP approval remain owned by Hydra.

The transport preserves Chromium's `browserContextId` in target metadata because Playwright requires it when attaching a page. Select actions call `locator.selectOption` directly with the option label. Explicit navigation resolves an ask-policy decision before starting `loadURL`; cancellation rejects the action. A blocked request or download retains the current document's preload readiness; a committed replacement document resets it until `dom-ready`.

## Alternatives considered

**Run Playwright MCP as a child server.** Rejected because it adds a second browser owner and loses Hydra's tab, policy, and session ownership.

**Expose a TCP remote-debugging port.** Rejected because the transport would widen the browser control surface and require port lifecycle management.

**Keep PageController for every action.** Rejected because it lacks Playwright's actionability and locator semantics for user-like interaction.

## Consequences

The browser package owns one Playwright dependency and a bounded transport adapter. Playwright action failures propagate through the existing browser error path. Accessibility snapshots remain Hydra projections and PageAgent remains an explicit fallback.

## Testing

The real Electron suite passes all 37 cases, including form entry and selection, native clicks, delayed enabled controls, drag, dialogs, uploads, navigation permissions, downloads, and embedded tab chrome. The child transport, browser service, and browser tool suites pass 105 cases. These checks cover local fixtures and the embedded controller; a packaged desktop session against live third-party websites remains unverified.

## Deferred

The [selective output decision](2026-09-13-browser-selective-output.md) owns regex snippets, Playwright refs, CSS targets, and optional snapshot/image omission. Full MCP diagnostic payload parity is outside the embedded Browser API.
