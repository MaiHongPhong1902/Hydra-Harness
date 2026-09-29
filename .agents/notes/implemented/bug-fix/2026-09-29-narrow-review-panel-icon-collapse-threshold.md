# Agent Note: right-panel tab row never collapsed to icon-only at its own tested width

Status: implemented

## Problem

`node 24 / snapshots and artifacts` failed `apps/web/tests/file-review.e2e.ts` on real hosted CI: after resizing to a 1000×760 viewport, the test polls until each of the right panel's 5 tab buttons (Files, Side chat, Browser, Terminal, Review) has its right edge at or before the x-position of the separately-rendered "Expand right panel" title-bar control. The poll timed out.

A debug-instrumented run captured the exact geometry: the right panel measured 706px wide (the `@container desktop-panel` `inline-size`), each of the 5 full-text tab buttons measured ~136px, and the row's rightmost button (Review) ended at x≈992 — well past the title-bar control's x=768. Two separate bugs combined to cause this:

1. `DesktopBrowserPanel.module.css`'s `@container desktop-panel (max-width: 570px)` rule, which hides button text, never engaged because the panel (706px) is far wider than 570px. The test's own "narrow" screenshot name and viewport choice indicate icon-collapse at this width was the deliberate original intent.
2. Hiding the text alone would not have been enough anyway: `.optionHeader > .options .option` sets `flex: 1`, so each button stretches to an equal 1/5 share of the row's full width regardless of whether it has text to show. A first attempt to override this inside the container query with `.options .option { flex: none }` had lower selector specificity (two classes) than the original rule (three classes via `.optionHeader > .options .option`), so it silently lost and button widths never changed — measured at the exact same ~136px in every verification run, mistakenly pointing at a stale-build theory for a long detour before the specificity mismatch was found by re-reading the two selectors side by side.

## Decision

**Raise the container-query breakpoint from 570px to 720px** (just above the 706px this test's viewport produces), **and add a same-specificity override** `.optionHeader > .options .option { flex: none }` inside the same query, so icon-only buttons actually shrink to their `min-width: 28px` instead of continuing to stretch. No other spec (grep'd across `apps/web/tests` and the `ui-layout` client unit specs) exercises this component at an intermediate container width, so nothing else depends on the old threshold or the old flex behavior.

## Consequences

At the tested 706px panel width, all 5 buttons now measure exactly 28px (icon-only, `min-width` floor) and end at x≈451 — comfortably before the x=768 control boundary. Wider panels (the ~1680px-viewport default most other specs use) stay far above 720px and keep full text at their original stretched width.

## Alternatives considered

**Changing the test's assertion instead of the CSS.** Rejected: the test's own "narrow" viewport and screenshot naming indicate icon-collapse was the deliberate original intent; changing the assertion would paper over a real, stale threshold rather than fix it.

**Overriding `flex` on `.option` directly (without the `.optionHeader >` prefix).** This was the first attempt and failed silently — CSS specificity, not container-query matching, decided which rule won. Kept as an object lesson in this note: verifying a CSS fix requires checking selector specificity against every rule it needs to beat, not just that the override rule matches the container query.

## Verification

In a from-scratch Linux container (matching the hosted runner): a debug-instrumented copy of the test now measures all 5 buttons at 28px width, ending well before the control boundary. Running the full, unmodified original test end-to-end now passes the narrow-panel assertion and progresses to a later, already-diagnosed, unrelated failure (`compareOrRefreshGolden` seeing "Kill bash" as disabled — this container's nested-virtualization sandbox has no working terminal backend, the same category of environment-only noise identified elsewhere this session, not a real bug and not something this change touches).
