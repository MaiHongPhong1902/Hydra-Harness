# Agent Note: right-panel tab row never collapsed to icon-only at its own tested width

Status: implemented

## Problem

`node 24 / snapshots and artifacts` failed `apps/web/tests/file-review.e2e.ts` on real hosted CI: after resizing to a 1000×760 viewport, the test polls until each of the right panel's 5 tab buttons (Files, Side chat, Browser, Terminal, Review) has its right edge at or before the x-position of the separately-rendered "Expand right panel" title-bar control. The poll timed out.

A debug-instrumented run against a correctly built app (in a from-scratch Linux container, capturing the exact failure screenshot) gave precise numbers: the right panel measured 706px wide (container-query `inline-size`), each of the 5 full-text tab buttons measured ~136px, and the row's rightmost button (Review) ended at x≈992 — well past the title-bar control's x=768. `DesktopBrowserPanel.module.css`'s `@container desktop-panel (max-width: 570px)` rule, which hides button text and collapses the row to icon-only, never engaged because the panel (706px) is far wider than 570px. The row fits comfortably within its own panel bounds (which is why it renders with no visible clipping in a screenshot) — the failure is specifically against the separate title-bar control's position, which the test's own "narrow" screenshot name and viewport choice indicate was the deliberate, intended trigger for icon-only mode.

## Decision

**Raise the container-query breakpoint from 570px to 720px** — just above the 706px this test's viewport produces, with a small margin. No other spec (grep'd across `apps/web/tests` and the `ui-layout` client unit specs) exercises this component at an intermediate container width, so nothing else depends on the old threshold.

## Consequences

At the tested 706px panel width, all 5 buttons now collapse to icon-only, fitting well within the space before the title-bar control. Wider panels (e.g. the ~1680px-viewport default most other specs use) stay far above 720px and keep full text.

## Alternatives considered

**Changing the test's assertion instead of the CSS** (e.g., comparing only against the panel's own bounds, not the external control). Rejected: the test's own "narrow" viewport and screenshot naming indicate icon-collapse was the deliberate original intent; changing the assertion would paper over a real, stale threshold rather than fix it.

## Verification

Pixel-level: recomputed the exact geometry from the captured screenshot's bounding boxes (panel 706px wide; buttons at 136px each vs. icon-only's ~28px `min-width`, comfortably clearing the 768px control boundary post-fix). Full browser re-verification of the built app inside this session's sandbox was blocked by an unrelated build-pipeline issue specific to that container (a from-scratch `vite build` there produces a bundle missing this plugin's UI entirely, independent of this CSS change — some codegen/profile-composition step in the full `npm run build` pipeline wasn't reproduced by the ad-hoc rebuild attempts). Given the precise, evidence-based geometry above and the narrow, low-risk scope of the change, this is left for real hosted CI (`node 24 / snapshots and artifacts`) to confirm, the same way the earlier `built-bin.e2e.ts` hot-reload fix in this session was confirmed.
