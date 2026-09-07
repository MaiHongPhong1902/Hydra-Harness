# Agent Note: Provider choice during first-run setup

Status: implemented

## Problem

A fresh profile with no usable model route opened a mandatory DeepSeek key dialog. That inferred a provider choice from the shipped adapter and hid the full configuration UI. The Models page also automatically expanded its DeepSeek editor, so navigating there alone could still ask for that provider's key.

## Decision

The Models plugin registers `ProviderOnboarding` as `provider-setup` after the versioned welcome notice. It reads the existing provider/settings/credential join and opens **Settings → Models** when no route is usable and a writable configurable-provider namespace is available. It completes the coordinator pass immediately. All editors remain closed until Edit, Add provider, or Add a custom provider is chosen. The Settings panel owns dismissal, drafts, validation, and writes; no onboarding-specific credential editor or secret-write path exists.

Readiness is provider-neutral. An active route with its named credential configured, including a read-only environment credential, or a route using reference-free native authentication skips setup. A failed join, failed credential reads, read-only settings, or no configurable provider skips automatic navigation. Dismissing official DeepSeek does not suppress configuration of other providers and does not restore the hidden route. No new persisted completion flag is introduced: closing Settings completes this pass, while a later blank-session pass may offer configuration if no provider is usable.

This supersedes the inline-key and automatic-editor decisions in [official DeepSeek setup](../feature/2026-07-30-deepseek-onboarding-credential-setup.md), [shared-modal onboarding](../feature/2026-08-13-shared-modal-product-onboarding.md), and [every-provider readiness](2026-08-12-onboarding-reads-every-provider.md). Those notes remain active for their shared-read, welcome-modal, native-authentication, and write-ownership rationale; none is wholly superseded. The [official DeepSeek dismissal](../feature/2026-09-04-official-deepseek-dismissible.md) still owns durable hiding and restoration.

## Alternatives considered

- Renaming the DeepSeek key dialog leaves the implicit provider choice intact.
- Rendering a second provider form inside onboarding duplicates the existing Settings UI and its validation and retry behavior.
- Removing the DeepSeek adapter changes configured and logged sessions; provider choice only needs to change navigation and editor activation.

## Consequences

The first-run route leads to the existing provider configuration page, which also supports custom endpoints and provider-native authentication. The welcome notice retains versioned acknowledgement and its modal ownership. Provider credentials remain write-only through the existing credential API, and the provider profile remains a separate settings write.

## Verification

Focused package tests cover provider-neutral readiness, navigation without writes, explicit editor activation, credential validation, and retry behavior. The keyless Web scenarios boot the shipped composition with an isolated home, snapshot the provider configuration page after welcome, configure DeepSeek or another provider through Settings, verify secret storage without DOM or console exposure, and check reload and provider dismissal/restoration.
