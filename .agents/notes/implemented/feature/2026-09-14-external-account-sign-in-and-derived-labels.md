# Agent Note: External account sign-in and derived account labels

Status: implemented

## Problem

Desktop account sign-in links were routed into Hydra's embedded browser, and OAuth flows asked users to invent labels even when the provider returned account identity data.

## Decision

Desktop exposes a validated HTTP(S) `openExternal` bridge backed by the operating system's default browser. Account sign-in links use that bridge when available and retain ordinary web-link behavior elsewhere. Account pools derive labels from provider credential fields and OAuth claims, with a provider-number fallback; ChatGPT and Antigravity no longer prompt for a manual label.

## Alternatives considered

**Route every external link through the operating-system browser.** Rejected because ordinary Hydra links still belong to the embedded browser surface.

**Keep manual labels as an override.** Rejected because it blocks provider-owned identity and duplicates information already returned by OAuth.

## Consequences

Desktop sign-in opens outside the Hydra window. Providers that return no usable identity still receive a stable provider account number, and the account label remains value-free metadata.
