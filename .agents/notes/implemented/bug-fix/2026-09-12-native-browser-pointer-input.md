# Agent Note: Native pointer input for controlled browser actions

Status: implemented

## Problem

Agent clicks only dispatched synthetic DOM events and moved a decorative cursor. Pages that depend on Chromium's native pointer path could not observe a user-like mouse move, press, and release.

## Decision

The Electron preload resolves indexed target coordinates and animates the pointer; the owning main process dispatches native CDP mouse movement, press, and release events for explicit PageAgent actions. Ordinary Hydra actions use [native Playwright](../feature/2026-09-13-native-playwright-controls.md).

## Alternatives considered

**Keep dispatching synthetic events only.** Rejected because it cannot exercise Chromium's native input path or browser event synthesis.

**Drive the operating-system cursor.** Rejected because Electron's WebContents input API reaches the controlled page without taking over the user's desktop pointer.

## Consequences

Embedded clicks use Chromium pointer and mouse events while the window is active and retain the visible simulator cursor. Standalone PageController users keep the prior behavior. Same-document navigation keeps the preload channel alive; a replacement document resets it and every readiness wait has a failure and timeout path.

## Testing

The Electron regression records pointer and mouse events from a real fixture and asserts that an agent click delivers movement, press, release, and click events. A same-document navigation regression keeps the page-control channel usable after `history.pushState`.

## Deferred

The preload pointer fallback retains its foreground-window requirement. [Native Playwright](../feature/2026-09-13-native-playwright-controls.md) owns ordinary drag and hover execution.
