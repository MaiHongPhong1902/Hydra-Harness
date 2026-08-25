# Agent Note: Flowspace spatial web theme

Status: implemented

## Problem

The web client needed a calmer, more legible visual hierarchy without changing its plugin composition, rendered DOM, accessibility relationships, or interaction behavior.

## Decision

`ui-theme` defines the Flowspace warm-neutral palette in `src/styles/design-platform.css` and maps it through the existing `--dsw-alias-*` layer for both body theme states. `src/styles/base.css` owns the shared radius, focus-ring, and quiet-motion values, and `gradient-shadow-text.css` supplies the restrained elevation tiers.

Feature packages continue to use their existing CSS Modules. The main frame, sidebar session rows, conversation document, composer, tool rows, code and terminal cards, settings panel, and trajectory cells consume those semantic values without JSX or TypeScript changes. Tool activity uses opacity and transform-only presentation motion, and reduced-motion users receive zero-duration theme transitions.

## Alternatives considered

**A second Flowspace stylesheet or component framework.** The existing static-to-semantic token system already provides light and dark ownership, so another global layer would duplicate theme state and weaken CSS Module boundaries.

**A component rewrite for layout control.** Existing markup, roles, IDs, data attributes, and event handlers remain the compatibility boundary; CSS supplies the visual hierarchy without changing any of them.

## Consequences

The visual system gains a consistent warm canvas, restrained rounded surfaces, visible keyboard focus, and a single accent across the existing client packages. The redesign deliberately leaves feature structure and behavior intact, so future visual changes continue through tokens and local CSS Modules rather than application logic.
