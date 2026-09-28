# Agent Note: browser_find precision and iframe origin labels

Status: implemented

## Problem

`browser_find` (`find_element` in the seam) answered a text/regex search with the matched line plus every ancestor's own line up to the tree root. On a real page that breadcrumb is mostly noise: generic wrapper `<div>`s with no name of their own, and — because the snippet selection also padded one line before and after each match — an unrelated sibling that happened to sit next to it in document order. The model asked "where is X" and received a chain of containers instead of X.

Pages with several iframes made this worse in a different way. Distilled snapshots come from Playwright's `ariaSnapshot({mode: 'ai'})`, which already recurses into same- and cross-origin frames and mints `f`-prefixed refs for their contents — that part worked. But an `- iframe [ref=...]` boundary line carried no indication of which origin it led to, so two visually similar embeds (a payment widget, a chat widget, a consent frame) were indistinguishable in the returned text; the model had no way to tell the model-facing content apart without guessing.

## Decision

**Tighter `find_element` snippets.** For each match, keep the matched line, walk forward to include its own subtree (so a matched container still shows what it holds), and walk backward only far enough to find the *nearest enclosing iframe boundary*, if any — not the full ancestor chain. Ordinary container ancestors (a wrapping `<div>`, a layout `<section>`) are dropped entirely; an enclosing iframe is kept because it is the one ancestor fact that changes what the match means. The one-line-of-context padding before/after each match is gone too, since it was the actual source of unrelated-sibling noise.

**Iframe origin labels.** `distilledSnapshot()` in `packages/browser/browser-electron/electron-app/main.cjs` now post-processes every `- iframe [ref=...]` line through `annotateIframes()`: it resolves the `<iframe>` element via the existing `nativeLocator()`/ref machinery, reads the element's own `src` attribute (a plain same-process DOM read — always available regardless of the frame's own attach state), and appends `(origin)` to the boundary line when `src` is an absolute http(s) URL. `srcdoc` frames and relative same-origin `src` values get no label, which is correct: there is no second platform to name.

`annotateIframes()` also splices a frame's own `ariaSnapshot()` in when the upstream line was left childless (no trailing `:`) — a defensive fallback for a composition gap in Playwright's own recursive splice that a targeted regex read of `packages/playwright-core@1.62.1`'s bundled `ariaSnapshotForFrame` appears to allow, even though it did not reproduce in the same-origin/cross-origin scenarios this change's own test exercises (Playwright's own splice covered both). The fallback costs nothing when unused and remains the correct behavior if a future Playwright version, a different node-naming scheme, or a depth-limited call ever hits the gap for real.

## Alternatives considered

**Read the resolved `Frame.url()` instead of the `src` attribute.** Tried first; empirically unreliable specifically for cross-origin frames under this seam's Playwright↔Electron bridge (see Consequences) — it returned an empty string for a cross-origin frame whose content had *already* rendered correctly in the composed snapshot. The `src` attribute needs no cross-target frame handle at all, so it is both simpler and strictly more robust.

**Keep the full ancestor breadcrumb, just shorter (e.g., two levels).** Rejected: an arbitrary depth cap is still noise for a deep DOM and still misses the one ancestor that actually matters (an enclosing iframe) when a match happens to sit three unlabeled `<div>`s below it.

## Consequences

**A pre-existing, unrelated limitation surfaced during testing, not introduced or fixed here.** `packages/browser/browser-electron/electron-app/playwright.cjs` fakes the `Target.setAutoAttach` handshake (`connectPlaywrightPage`) to present Playwright with one flat page target; it never forwards the real command or relays `Target.attachedToTarget` for a target Electron creates after that handshake. A cross-origin iframe inserted into a page *after* Playwright's connection to that tab was already established can therefore never resolve — reproduced independently through the already-documented `target: "iframe >> selector"` chaining, with no `annotateIframes` code in the call path at all. `packages/browser/browser-electron/tests/electron.spec.ts`'s new test works around this by opening a fresh tab and inserting all content, including both iframes, before the tab's first native action — which is also why the cross-origin assertion checks the origin label via an untargeted `get_browser_state({snapshot:{}})` read rather than `find_element` locating text inside the frame: the label only needs the top-level `<iframe>` element, so it stays reliable even when this pre-existing gap makes the frame's own content unreachable.

**Verified against real Playwright 1.62.1 behavior, not just its source.** A first pass at this fix assumed (from a static read of the bundled `ariaSnapshotForFrame` splice regex) that a *named* iframe (one with a `title`) broke Playwright's own recursive composition. A real end-to-end run against Electron falsified that: named iframes spliced correctly on their own in every case exercised. The shipped fallback stayed in as a defensive no-cost branch rather than being deleted, since the regex gap is real code, just not one this change's scenarios could trigger.
