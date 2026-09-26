# Agent Note: Desktop title bar and application menus

Status: implemented

## Problem

The Electron shell used the platform titlebar and exposed no product-level Back, Forward, Sidebar, File, Edit, View, or Help controls. The desktop window also needed a stable content inset for native window controls without widening the renderer's IPC authority.

## Decision

Electron renders the web client with a custom 36px top bar inside the titlebar overlay on supported desktop platforms. The bar provides Back and Forward controls, a Sidebar control, and File, Edit, View, and Help menus. Renderer menus use the shared `Menu` and `Tooltip` primitives, keep their triggers keyboard-operable, and route session, workspace, and panel actions through the existing client services. Actions that require the main process use a narrow allowlist for editing commands, zoom, fullscreen, close, and help. ChatGPT-only menu entries are not presented because Hydra does not provide their backing behavior.

## Alternatives considered

**Keep the platform titlebar and native application menu.** Rejected because the desktop surface needs the same product controls and visual height across supported platforms, while the renderer owns session, workspace, and panel state.

**Expose a general renderer-to-main action channel.** Rejected because editing, zoom, fullscreen, close, and help are the complete native action set; an allowlist keeps the preload authority explicit.

**Copy ChatGPT's full menu catalog.** Rejected because entries without Hydra services would advertise behavior the product cannot execute.

## Consequences

The desktop shell has a consistent 36px product bar and reserves the titlebar overlay area for native window controls. Browser clients keep the existing web layout without the desktop bar. Menu keyboard handling and tooltips remain shared UI behavior, while native operations remain sender-validated and limited to the allowlisted actions.

## Testing

The desktop smoke and focused `ui-layout` checks cover the custom bar's rendered controls, menu actions, titlebar geometry, and native action dispatch; browser-only runs continue to exercise the web shell without desktop titlebar state.
