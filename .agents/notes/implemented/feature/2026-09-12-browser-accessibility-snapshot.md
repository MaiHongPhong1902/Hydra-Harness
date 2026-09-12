# Agent Note: Chromium accessibility snapshots and local browser tools

Status: implemented

## Problem

A DOM-first page description makes agents choose controls from markup instead of the browser's accessible roles, names, and states. Synthetic clicks also omit the trusted native events that some pages require.

## Decision

Chromium's CDP Accessibility.getFullAXTree supplies the model-facing snapshot. A private DOM walk joins backend node ids to PageController's numbered action refs; password values are redacted. Hidden HTML file inputs remain explicit upload targets with id and name metadata. Accessibility failures propagate instead of silently substituting a hand-written ARIA approximation.

Hydra implements browser tools locally over its existing permission, tab, attachment, and session services. The upstream reference is @playwright/mcp 0.0.80 with playwright-core 1.63.0-alpha-2026-08-31. No MCP server or runtime dependency is added. Tool names follow upstream, while Hydra keeps numeric element refs and tab ids. Native click, hover, drag, data/file drop, bounded text waits, viewport resizing, alert/confirm handling, and bounded console/network reads use the controlled tab's CDP connection. File drops validate and approve every path under Uploads permissions before any transfer.

The [ignored-node projection](2026-09-10-browser-ignored-node-filtering.md) still owns output filtering and preserves refs. The [native-pointer decision](../bug-fix/2026-09-12-native-browser-pointer-input.md) retains the foreground-window requirement and hidden-click fallback.

## Alternatives considered

**Run Playwright MCP as a second browser server.** Hydra already owns the browser lifecycle and permissions. Local tools preserve those owners.

**Hand-write ARIA semantics from DOM attributes.** This duplicates Chromium's accessible-name computation and can misreport nontrivial labels and states.

**Rename isolated-world JavaScript to browser_run_code_unsafe.** Upstream executes host-side code with a Playwright Page object. The isolated-world evaluator does not implement that behavior and must not advertise it.

## Consequences

The model receives Chromium accessibility semantics with the existing action refs. Native gestures require the selected tab in a visible foreground window; hidden or unfocused clicks retain PageController's fallback. Dialog snapshots keep their footer visible even when page content is unchanged. Console/network records are bounded and reset on navigation; raw CDP domains are detached when navigating beyond their approved document.

Real Electron tests cover trusted pointer events, text waits, resize, confirm dialogs, data drops, request bodies, upload policy, and autofill privacy. The runnable ACP browser snapshot pins tool schemas, guidance, and accessibility output.

## Deferred work

This is not full Playwright MCP parity. Host-side unsafe code, locator-string targets, checkbox/radio form filling, multi-file chooser semantics, full-page screenshots, prompt dialogs, and optional MCP capability groups remain unimplemented. Electron does not supply native JavaScript prompt dialogs. The package READMEs own these consumer limits.
