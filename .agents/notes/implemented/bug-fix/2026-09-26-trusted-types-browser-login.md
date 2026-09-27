# Agent Note: Trusted Types compatibility for browser credential entry

Status: implemented

## Problem

Google and Facebook login pages can enforce Trusted Types. The Hydra PageAgent overlay used `innerHTML` for its static scroll indicator, so overlay initialization failed before browser actions could enter credentials.

## Decision

The local BrowserAgent `SimulatorMask` builds the scroll indicator with `createElementNS`, `setAttribute`, and `appendChild`. The committed Electron preload is regenerated from that source. A native Electron test serves a Trusted Types login form and verifies that a password can be entered.

## Alternatives considered

**Keep the HTML assignment** was rejected because the provider page policy blocks it.

**Disable the PageAgent overlay on provider pages** was rejected because it removes the shared interaction path and leaves the same failure available on other Trusted Types pages.

## Consequences

Credential entry keeps working on pages that reject string HTML assignments. The generated preload must be rebuilt whenever the local BrowserAgent source changes.
