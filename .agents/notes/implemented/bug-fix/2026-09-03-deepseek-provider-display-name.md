# Agent Note: DeepSeek provider display ownership

Status: implemented

## Problem

The `deepseek-official` adapter exposed `BHAgent` and `BHAgent`-prefixed V4 model display names. `BHAgent` independently names the built-in browser control actor and destination, so model selection, onboarding, and search settings presented a DeepSeek transport as the browser identity. Client fixtures, API fixtures, tests, and Web snapshots copied that ambiguity.

## Decision

The DeepSeek adapter catalog owns the `DeepSeek` provider name and `DeepSeek-V4-*` model names in [`llm-deepseek`](../../../../packages/llm/llm-deepseek/src/index.ts) and its adapter metadata. The DeepSeek Web search plugin likewise identifies itself as the DeepSeek search provider. Client and host fixtures, settings copy, model-selection expectations, and Web snapshots mirror those owner values.

This is a display-only correction. The provider id `deepseek-official`, model ids `deepseek-v4-*`, package and settings namespace `llm-deepseek`, environment variables `DEEPSEEK_*`, and DeepSeek endpoint remain unchanged.

`Hydra harness` names the browser control actor; `bhagent` remains its destination id, as described by [desktop browser settings](../feature/2026-08-26-desktop-browser-settings.md). Branding work classifies that term by owner instead of applying a repository-wide replacement.

## Verification

Focused DeepSeek adapter, configurable-provider, client fixture, settings, model-selection, API-proxy, SDK, replay, and Web tests pin the provider and model labels. Web snapshots pin the assembled model picker, onboarding, and search-provider copy. A tracked-source residue scan finds no `BHAgent`-prefixed V4 model label and preserves the historical provider labels only in this ownership note.

## Alternatives considered

**Keep `BHAgent` as a DeepSeek provider alias.** Rejected because the same name already identifies browser control and obscures which external provider owns the models and search API.

**Rename the DeepSeek technical identifiers with the display text.** Rejected because transport ids, credentials, settings, routes, and persisted configuration already describe DeepSeek correctly. Changing them would create migration work without fixing an additional user-visible defect.

## Consequences

Provider-facing UI identifies DeepSeek consistently while existing configuration remains compatible. Browser settings identify the actor as `Hydra harness`; provider names remain independent of product branding.
