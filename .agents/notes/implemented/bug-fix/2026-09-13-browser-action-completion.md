# Agent Note: Browser action completion and observation scheduling

Status: implemented

## Problem

Rejecting a host promise does not stop a browser command. A waiting click can execute after cancellation, while another action already uses the same tab. Repeated full observations also impose a quiet-period delay, and accepting a title as usable content exposes incomplete application shells as settled pages.

## Decision

Each protocol request owns an AbortController and its completion promise. Cancellation identifies the request, withdraws permission questions, and disconnects its pending Playwright connection without closing the tab. The host retains the pending call until Electron acknowledges completion. Already-dispatched preload work completes before rejection; cancellation cannot undo completed input or page-owned timers. Timeout requests cancellation before closing an unresponsive child. Desktop owner transitions cancel and join outstanding requests before acknowledging the next connection.

Full observations require page content and retry interrupted document reads. A settled observation may skip another quiet period only when the URL and content still match; actions and document navigation invalidate that observation. Metadata-only reads do not traverse the page, replace its captured state, or refresh numeric refs. They report native loading and dialogs, not application-content readiness.

Native text selection temporarily disables renderer throttling. Browser chrome preserves tab focus during updates only while its document has focus, and uses native buttons for keyboard activation. Desktop panel shortcuts apply only to the app renderer.

## Alternatives considered

**Reject immediately and ignore the late reply.** This releases the tab queue while its operation can still mutate the page.

**Close the tab whenever the user cancels.** Disconnecting the Playwright transport stops pending locators while preserving the user's document.

**Remove readiness waiting entirely.** SPA shells and redirects still need bounded observation; unchanged settled documents and result-only reads avoid that cost independently.

## Consequences

Cancellation may wait for already-dispatched preload work. Unresponsive processes can lose their open tabs when the shutdown deadline expires. Metadata consumers must request a full observation before using numeric refs or judging page content.

The native Electron tests cover cancelled clicks and reconnection, title-first hydration, metadata without ref mutation, navigation, text selection, tab focus, and Enter/Space activation. Child and tool tests cover cancellation acknowledgement and capture omission; runnable ACP browser scenarios pin model output. Desktop smoke covers native tab shortcuts in the assembled app.

The [native Playwright decision](../feature/2026-09-13-native-playwright-controls.md), [selective output decision](../feature/2026-09-13-browser-selective-output.md), and [virtual cursor decision](../feature/2026-09-13-browser-virtual-cursor-enhancements.md) remain active for their independent transport, evidence, and selection guarantees.
