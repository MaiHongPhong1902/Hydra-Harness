---
name: hydra-ux-review
description: Review Hydra-Harness user journeys, form behavior, accessibility, and visual consistency. Use when asked to audit UX or evaluate a screen or flow. A review alone is read-only; it does not activate a general code or security audit.
---

# Hydra UX Review

Review the requested Hydra-Harness surface. Paths below are relative to the verified checkout root. Existing authorization to implement or fix remains valid; a review request alone does not authorize edits.

## Establish the journey

Read the applicable [repository instructions](../../../AGENTS.md) and [styling rules](../../../docs/web-styling.md). Inspect the real screen when available and identify the user's starting state, intended result, and each required action. For a screenshot-only review, separate visible evidence from behavior that requires runtime confirmation.

Trace suspicious behavior to its owning component, store, and Host response. Configuration, credential storage, plugin enablement, and provider availability are distinct states. Do not infer successful authentication from a saved-key indicator or confuse a disabled optional plugin with a broken provider.

## Examine the affected decisions

Select the checks that matter to the requested flow:

- **Discoverability:** the next action and its consequence are clear; terminology follows adjacent screens; a simple value does not require a needlessly complex interaction.
- **Editing and recovery:** defaults are understandable; validation identifies the field and remedy; Save, Discard, and Reset have distinct effects; pending or failed requests preserve recoverable drafts.
- **State continuity:** saved values and configured rows survive the lifecycle they promise, including reload, section changes, and plugin toggles when relevant. Loading, empty, unavailable, and permission-denied states are distinguishable.
- **Keyboard and accessibility:** fields have accessible names; focus remains visible and usable; menus and dialogs support the advertised keyboard interaction and dismissal; errors are available as text and correctly associated with fields.
- **Visual consistency:** compare equivalent controls against the shared style rules, including theme contrast, label spacing, text wrapping, narrow panes, and long translated labels. Judge editor exceptions by their geometry requirements.

Use temporary test profiles for state-changing experiments when practical. Do not turn an observation into a save, deletion, or external provider call that the user did not request.

## Report evidence

Prioritize blocked tasks, lost input, misleading state, and inaccessible controls ahead of cosmetic differences. Each actionable finding states the reproduction or source location, observed behavior, user impact, and the smallest plausible remedy. Distinguish reproduced defects, source-supported defects, and unverified concerns.

If no actionable issue is found, say so and state the tested scope. Do not invent findings to fill a checklist or claim runtime coverage from source inspection. Use [Hydra UI Verify](../hydra-ui-verify/SKILL.md) when additional behavioral evidence is needed, or [Hydra UI Design](../hydra-ui-design/SKILL.md) for an authorized redesign.
