# Agent Note: Web provider choice starts unselected

Status: implemented

## Problem

The Web composition inherited the base DeepSeek default and had no onboarding base value, so a fresh installation selected DeepSeek and showed its row before the user chose a provider.

## Decision

The Web bundle overrides `agent-default-model` with an unroutable selection and `ui-settings-general` hides the shipped official DeepSeek row by default. Adding DeepSeek writes `deepseekOfficialDeclined: false`; deleting it writes `true`. The headless base fallback remains DeepSeek.

## Alternatives considered

**Keep the base DeepSeek default** still selects a provider before the user makes a choice.

**Unset the hide flag when adding DeepSeek** would restore the composition default of `true`, so the provider would remain hidden on a fresh Web installation.

## Consequences

New Web sessions wait for an explicit provider and model choice. The adapter remains mounted, and adding DeepSeek restores its row and catalog without changing existing explicit or logged selections.
