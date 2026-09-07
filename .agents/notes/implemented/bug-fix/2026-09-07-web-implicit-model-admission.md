# Agent Note: Require a visible implicit model before Web prompt admission

Status: implemented

## Problem

A blank Web session can display `Select model` while inheriting a default whose catalog row was removed or whose provider was dismissed. Checking only adapter registration lets that invisible default receive the prompt, including an unconfigured DeepSeek route.

## Decision

The Host requires visible catalog membership for an implicit default before accepting a prompt. Explicit session choices and logged request selections retain advisory routing. `session.models.routable`, prompt admission, and revision validation share the decision; the existing browser block preserves the draft and keeps model selection available.

This narrows admission for implicit defaults in the [Web selector](../feature/2026-07-24-web-session-model-selector.md) and [default preference](../feature/2026-08-07-default-model-follows-the-picker.md) decisions. Those notes remain active because they own selection persistence, assembly timing, and shared preferences.

## Alternatives considered

**Block only in the browser.** Direct prompt requests can bypass the composer, so the Host must reject before accepting input.

**Require catalog membership for every selection.** Existing sessions and explicit API choices can use valid unadvertised models; catalog edits must not invalidate their recorded routing.

## Consequences

An unavailable implicit catalog requires selection or catalog recovery before the first prompt. No fallback provider is substituted. This does not validate credentials for an explicitly selected provider.

Host tests cover absent defaults, empty and failed catalogs, dismissed DeepSeek, explicit recovery, logged choices, and rejection before inbox admission. The keyless Web scenario removes the implicit model, snapshots the blocked composer, and checks that selecting a replacement restores the preserved draft.
