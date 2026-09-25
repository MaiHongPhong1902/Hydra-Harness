# Agent Note: Shared native field and dropdown styling

Status: implemented

## Problem

Settings forms, toolbar filters, and value pickers repeat their own border, font, sizing, and focus declarations. Those copies diverge across packages and make a theme change require unrelated feature edits. Text editors also have geometry requirements that ordinary field rules cannot safely replace.

## Decision

Native controls declare a styling role through `data-hydra-control`; the theme owns their shared CSS. Regular and compact controls cover forms and toolbars. Embedded inputs delegate their chrome to the containing control. Editors retain their measured typography and layout, and action menus retain button presentation. The [style reference](../../../../docs/web-styling.md#form-controls-and-dropdowns) owns the usage rules.

The TSX gate rejects missing or incompatible roles in production sources and runs through `doc-sync` and CI. Browser checks exercise the assembled Settings and composer surfaces in both themes, including focus, disabled controls, native selection, and narrow layouts. The [web styling framework decision](../process/2026-07-19-web-styling-system.md) remains the owner of CSS Modules and theme architecture.

## Alternatives considered

A component-library migration adds dependencies and replaces native interaction behavior for a styling problem. Routing every field through one React wrapper adds prop plumbing to controls that already own their state. Per-package CSS copies preserve the original source of drift.

## Consequences

One stylesheet changes ordinary field chrome across the assembled application. Feature CSS remains responsible for layout and editor geometry. Native select popups retain platform differences. The gate cannot prove that an exemption describes the correct purpose or that a local CSS rule preserves the shared appearance; review and browser checks cover those limits.
