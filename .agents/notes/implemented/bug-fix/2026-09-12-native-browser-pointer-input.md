# Agent Note: Native pointer input for controlled browser actions

Status: implemented

## Problem

Agent clicks only dispatched synthetic DOM events and moved a decorative cursor. Pages that depend on Chromium's native pointer path could not observe a user-like mouse move, press, and release.

## Decision

The Electron preload resolves indexed target coordinates and animates the pointer; the owning main process dispatches native CDP mouse movement, press, and release events. The embedded preload wraps PageController actions and keeps the existing synthetic fallback when the native window is hidden or unfocused.

## Alternatives considered

**Keep dispatching synthetic events only.** Rejected because it cannot exercise Chromium's native input path or browser event synthesis.

**Drive the operating-system cursor.** Rejected because Electron's WebContents input API reaches the controlled page without taking over the user's desktop pointer.

## Consequences

Embedded clicks use Chromium pointer and mouse events while the window is active and retain the visible simulator cursor. Standalone PageController users keep the prior behavior. Same-document navigation keeps the preload channel alive; a replacement document resets it and every readiness wait has a failure and timeout path.

## Testing

The Electron regression records pointer and mouse events from a real fixture and asserts that an agent click delivers movement, press, release, and click events. A same-document navigation regression keeps the page-control channel usable after `history.pushState`.

## Deferred

Native drag and hover use the same foreground-window requirement; [the accessibility tools note](../feature/2026-09-12-browser-accessibility-snapshot.md) owns their semantics.
