# Agent Note: Provider sign-in through the default browser

Status: implemented

## Problem

Launching Gemini sign-in through Playwright puts an installed supported browser under automation. Google can reject this session with “This browser or app may not be secure”; its [supported-browser guidance](https://support.google.com/accounts/answer/7675428?hl=en) identifies automated and embedded browsers as possible causes. The user also requires the operating system's configured default browser.

## Decision

Every provider's Open sign-in page action uses Desktop's validated `openExternal` IPC and Electron's `shell.openExternal`. The operating system chooses the browser and profile. Hydra starts no automated browser for sign-in, performs no implicit browser-profile import, and leaves that external browser open when its authorization attempt ends. Web retains a normal new-tab link.

## Alternatives considered

**Launch a particular installed browser through automation.** Rejected because it ignores the user's default and remains a browser Google may reject.

**Automatically read the default browser's session.** Rejected because a normal external link gives Hydra no cookie access or authorization-completion callback. Such an integration needs a separate explicit browser-side capability.

## Consequences

Account connections make completion explicit. Antigravity retains its browser OAuth callback flow. Focused component and assembled snapshots cover external-link dispatch and account connection; the Desktop smoke checks renderer IPC reaches the system-browser opener and rejects unsupported URLs. These checks do not establish that Google accepts a particular account or browser configuration.
