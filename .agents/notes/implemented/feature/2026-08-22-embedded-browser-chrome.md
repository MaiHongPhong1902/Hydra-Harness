# Agent Note: Embedded browser chrome

Status: implemented

## Problem

The controlled browser showed only the page, which made it unlike a normal Chromium window and gave the user no visible tab or address/search entry point.

## Decision

Add a sandboxed static `WebContentsView` above the controlled page views. It owns the native tab strip, Back, Forward, Reload, and omnibox controls. An `http:` or `https:` omnibox value opens as an address; other text searches Google. The tab owner is [Active controlled browser tabs](2026-08-22-active-controlled-browser-tabs.md).

The chrome has its own preload with private IPC and no `contextBridge`. The controlled page stays in its existing `PageController` preload, so all `browser_*` DOM automation remains unchanged.

## Alternatives considered

**Use the webpage for browser UI.** Rejected because an external page cannot safely own browser navigation controls or access the private Electron IPC channel.

## Consequences

The chrome remains separate from page-agent and cannot give a hostile page access to its IPC channel. User-tab ownership, selection, and close behavior are defined in [Active controlled browser tabs](2026-08-22-active-controlled-browser-tabs.md).

## Testing

The real-Electron fixture confirms the selected `PageController` view remains below the native chrome and all existing DOM actions still work.

## Related

The browser's Chromium-compatible SSO navigation policy remains in [Chromium-compatible embedded browser navigation](../architecture/2026-08-22-unrestricted-embedded-browser-navigation.md). The package boundary and text-DOM decision remain in [Embedded browser driven by the harness's own loop](2026-08-22-embedded-browser-page-agent.md).
