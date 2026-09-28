# Agent Note: Native-input navigation flakes in the browser-electron E2E suite

Status: implemented

## Problem

`electron.spec.ts`'s `keeps user browsing independent from agent navigation policy` test failed intermittently and reproduced on a clean `main` checkout, unrelated to any feature work in flight. Diagnosis needed real native Electron runs since the failure depended on Chromium-internal timing, not anything visible from the test's own assertions.

Two distinct causes were found, both pre-existing:

1. The test sends a real native mouse click on a link immediately after an agent-triggered `Enter` keypress on that same link was correctly blocked by navigation policy. Sometimes Chromium never fires a fresh `will-navigate` for the click at all — it appears to treat a navigation to the same URL, issued too soon after an identical one was just cancelled, as a duplicate and silently drops it. The DOM `click` event still fires normally (`defaultPrevented: false`), so nothing at the JavaScript layer signals that navigation was swallowed.
2. Separately, the `press` command's `contents.focus()` call in `packages/browser/browser-electron/electron-app/main.cjs` runs unconditionally, even when the target is already focused. Occasionally this redundant focus call raced with the synthetic `keyDown` sent immediately after it, and the renderer never received the key event at all (confirmed via `document.hasFocus()`/`document.activeElement` staying correct throughout, with `will-navigate` never firing for that press).

## Decision

**Settle delays around the two known Chromium timing gaps**, in `packages/browser/browser-electron/tests/chrome-ui.cjs`: one after establishing DOM focus and before sending the blocked `Enter` press, one after that press is confirmed blocked and before the real mouse click on the same link. Both are ~150ms — the minimum needed to consistently unstick the corresponding gap.

**Retry the blocked `Enter` press up to 5 times** (spaced 1s apart, well inside the test's 25s stall budget) before asserting it was blocked, since a single `sendInputEvent` delivery isn't guaranteed.

**Skip the redundant `contents.focus()` in the `press` handler** (`main.cjs`) when the target is already focused — `if (!contents.isFocused()) contents.focus()`. This is a real production fix, not just a test workaround: any caller of `press` on an already-focused target was exposed to the same rare dropped-keydown race.

## Consequences

Empirically dropped the failure rate on this test from roughly 40-60% (dominant cause: the click-after-cancelled-navigation gap) to under 2% across ~100 combined runs on real hardware, with the residual failures being the rarer, still-not-fully-eliminated dropped-keydown case. Perfect reliability for native, OS-level synthetic input on a real (non-virtualized) Windows desktop is not guaranteed by any of these mitigations; they close the two concretely diagnosed gaps rather than papering over the symptom with a broader retry-the-whole-test hack.

## Alternatives considered

**Wrapping the whole test in a retry/skip-on-flake.** Rejected: it would have hidden the genuine, fixable `contents.focus()` race in production code and left the far-more-common click-after-cancelled-navigation gap undiagnosed.

**A single, longer catch-all delay instead of two targeted ones.** Rejected: the two gaps are unrelated (one is about focus settling, the other about a cancelled navigation's teardown), and conflating them into one guess-and-check delay would be harder to justify or retune later.

## Verification

`packages/browser/browser-electron/tests/electron.spec.ts`'s full suite (50 tests) passed in 2 of 3 back-to-back real-Electron runs before this fix reliably reproduced the target test's failure; after the fix, the target test passed ~98+ of ~100 isolated runs and the full suite passed 3/3, plus `service.spec.ts` (68 tests) and `tool-browser.spec.ts` (65 tests) alongside it.
