# Agent Note: Account sign-in usage reports

Status: implemented

## Problem

Account sign-in showed only provider-owned labels, so users could not tell which account had available five-hour or weekly capacity before choosing a model.

## Decision

The Host owns a value-free `authorization.usage` RPC. Each registered account flow may fetch a provider report while its credential remains inside the Host credential store. ChatGPT uses the official usage and reset-credit endpoints, preserving provider-reported five-hour, weekly, tier, reset, and banked-reset fields. Antigravity reads quota and tier fields from its Cloud Code Assist responses. The UI renders only fields returned by the provider and shows unavailable when a provider omits them.

## Alternatives considered

- Calculating limits from request history was rejected because local traffic does not represent provider-wide quotas or reset credits.
- Sending access tokens to the browser was rejected because Account sign-in credentials remain Host-owned.

## Consequences

Usage is an explicit per-account refresh, so a provider outage does not block account listing or sign-out. Provider response formats can change; malformed quota fields fail closed to an unavailable report rather than inventing a limit, while an unavailable optional banked-reset endpoint leaves the other usage fields intact.

The Account sign-in editor renders one compact quota-card layout for every account. Codex cards show provider-reported five-hour and weekly windows plus banked resets; Antigravity cards group provider-reported quota-summary buckets by Gemini, Claude/GPT, and other model families, with remaining counts, disabled states, and credit balances when supplied. The browser does not manufacture shared windows, credit balances, or overage settings when Antigravity omits them.
