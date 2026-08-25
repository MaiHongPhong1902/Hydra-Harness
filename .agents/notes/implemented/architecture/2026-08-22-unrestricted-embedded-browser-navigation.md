# Agent Note: Chromium-compatible embedded browser navigation

Status: implemented

## Problem

Enterprise SSO remained on its organization redirect screen because the embedded browser denied the cross-origin navigation and popup steps that the identity provider initiates. The browser needs to complete ordinary Chromium login flows with its persistent Bosch Harness profile.

## Decision

Remove the per-origin approval and allowlist from `browser_navigate`, `BrowserSessionService`, and Electron's main process. `browser_navigate` still accepts only absolute `http:` and `https:` URLs, but opens them without approval. The view permits page redirects, links, and `window.open` popups exactly as Chromium does.

Keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and the persistent `<harness-home>/browser-profile`. Popups are native user windows; the text-DOM tools continue to control only the owner’s primary view.

## Alternatives considered

**Allowlist additional SSO hosts.** Rejected because the broken part is page-initiated navigation and popup hand-offs, which vary by identity provider and cannot be predictably enumerated.

**Allow only same-window redirects.** Rejected because enterprise SSO can use popup windows, and that would retain the reported failure mode.

## Consequences

The user explicitly chose Chromium-compatible unrestricted navigation. An untrusted page that reaches the browser can now steer a profile authenticated to any reachable system, so this capability must not be composed where untrusted content and sensitive SSO credentials share a profile.

No approval or origin-grant state survives in the service, and a replacement browser window has no policy state to replay. The browser remains headed, and its primary view remains text-DOM controlled.

## Testing

The tool tests prove a new HTTPS origin reaches the Electron seam without an approval call. The real-Electron fixture proves a page-initiated navigation replaces the primary document. The user must restart the existing browser window to load the new Electron main process before manually completing SSO.

## Related

This supersedes only the origin-approval and navigation-blocking portions of [Embedded browser driven by the harness's own loop](../feature/2026-08-22-embedded-browser-page-agent.md). The original note still owns the browser's package boundary, Electron transport, text-DOM modality, and persistent profile decisions.
