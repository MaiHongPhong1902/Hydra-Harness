---
name: hydra-ui-design
description: Design and implement user-facing screens, forms, dropdowns, and layout changes in Hydra-Harness. Use for new UI, redesigns, or visual consistency work; not for unrelated websites or backend-only changes.
---

# Hydra UI Design

Work in the current Hydra-Harness checkout. Paths below are relative to its repository root, not this skill directory. Preserve the user's chosen scope, brand, and existing worktree edits.

## Find the owner

Read the applicable [repository instructions](../../../AGENTS.md), [client instructions](../../../packages/client/AGENTS.md), and [styling rules](../../../docs/web-styling.md). Inspect the existing screen and its owning component before choosing a visual treatment. Use the repository's structural lookup tools when available; inspect nearby sources when they are not.

Trace controls that save or trigger work through the component, store, Host API, and refreshed state. Identify which plugin contributes the screen or slot. A visual change must preserve that ownership and its persistence behavior.

## Choose the interaction

Identify the user's task, primary action, and the information needed to complete it. For the affected flow, distinguish initial, empty, loading, draft, invalid, saving, saved, unavailable, and read-only states where they actually exist. Avoid adding states or controls for services the product does not provide.

Keep Save/Apply and Discard semantics consistent with the owning form. Do not report success until the Host acknowledges it, or erase a recoverable draft after a failed write. A configured credential indicator represents stored configuration, not a verified live provider connection.

Use the existing page hierarchy and density. Give labels, instructions, errors, and actions clear relationships; keep implementation details out of product copy unless they affect a user's decision. Follow the repository's locale and copy conventions.

## Implement through the shared system

Read the [shared control styles](../../../packages/client/ui-theme/src/styles/controls.css) and inspect relevant [UI primitives](../../../packages/client/ui-primitives/src). The style reference owns control variants and dimensions; do not maintain another table of values in feature CSS.

- Choose `data-hydra-control` from the current form-control rules. Composite inputs delegate chrome to their wrapper. Editor exceptions preserve measured glyphs, resize behavior, and native editing.
- Use native selects for simple values and the existing Menu or specialized picker for rich choices. Keep native select arrows and platform popups.
- Put shared visual changes in the theme or owning primitive. Feature CSS owns layout; avoid per-screen copies of border, font, focus, or disabled rules.
- Preserve labels, ARIA relationships, keyboard handling, and focus visibility. Use semantic error tokens with explanatory text; avoid color-only status.
- Check long labels, empty content, narrow panes, both themes, and reduced motion on the changed surface. Keep source, terminal, and diff content unwrapped when column preservation is required.

Use the current CSS Modules and token system. Do not introduce a component library or another theme layer merely to restyle existing controls.

## Finish

Implement the authorized change, then use [Hydra UI Verify](../hydra-ui-verify/SKILL.md) for the evidence appropriate to its scope. Update owning documentation and Agent Notes when repository policy requires them. Report the changed user behavior, verification performed, and any remaining limitation; distinguish a design proposal from a working implementation.
