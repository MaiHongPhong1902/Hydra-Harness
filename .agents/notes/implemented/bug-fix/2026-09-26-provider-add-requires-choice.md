# Agent Note: Provider add requires an explicit API-key choice

Status: implemented

## Problem

The Models page opened the first selectable API-key provider as soon as the user clicked **Add provider**. A hidden official DeepSeek route could therefore become the active add target without an explicit choice.

## Decision

API-key provider additions open with an empty native provider select. The editor appears only after the user selects a provider. Account-provider additions retain their existing first-provider shortcut because that action repeats an account sign-in flow.

## Alternatives considered

**Remove DeepSeek from the provider list** was rejected because users can still choose it deliberately after dismissing it.

**Keep the first provider as the default** was rejected because directory order is not a user choice.

## Consequences

The first-run Models page and every API-key add flow remain provider-neutral. Existing account sign-in behavior is unchanged.

## Verification

The Models component, onboarding, and readiness tests pass together (95 tests). The UI control verification and focused Oxlint checks also pass.
