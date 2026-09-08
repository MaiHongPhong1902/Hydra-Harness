# Agent Note: Active controlled browser tabs

Status: implemented

## Problem

One selected-page target cannot preserve independent page state, element indices, and autonomous PageAgent work across the tabs needed by multi-application testcase flows.

## Decision

Each controlled tab owns a `WebContentsView` with the PageAgent preload and shares the Electron profile with the other tabs in its agent-owned window, so SSO cookies remain available. The native chrome and model can add, select, and close tabs. A user closing the final tab closes the standalone browser window; in the desktop shell it hides the native views and removes the Browser panel tab while retaining the shell and its other panels. Page-initiated closure uses the same tab cleanup. The model's close action keeps its final-tab guard so that its command and trailing observation can finish.

An empty embedded browser retains its controller connection and profile. Opening Browser from the panel options or making a page action without a tab id creates a fresh controlled tab; an explicit stale id still fails rather than targeting another document. Closing the Browser panel itself resets its reveal state so the next agent action can restore it. A new tab commits its blank document before a PageController request because an unloaded view has no preload listener.

`BrowserState.tabId` identifies the page that supplied a snapshot and owns its element indices. `BrowserState.activeTabId` identifies the tab selected in the visible chrome. Every page-local model tool accepts optional `tab_id`; omission captures the selected tab, while an explicit id keeps the action and trailing state read bound to that tab.

Calls without an explicit target and tab-lifecycle actions are window-wide barriers. Explicit calls are ordered within one tab and may overlap across different tabs. Selecting another tab changes visibility but does not cancel an explicitly targeted DOM action or PageAgent model request; navigation, renderer loss, or closure rejects only the affected tab's work.

Consumers that derive page-to-page context key their previous observation by `tabId`; interleaved results cannot create a false transition from one tab into another.

Native tab titles use `textContent`. A denied `window.open()` is adopted into a new controlled tab so the model and user retain one tab inventory and one profile.

## Alternatives considered

**Add cosmetic plus and close controls.** Rejected because controls without isolated page lifecycles would lose existing pages on selection and misrepresent browser behavior.

**Require `browser_switch_tab` before every action.** Rejected because active-tab routing cannot safely express independent concurrent work: one switch can retarget or cancel another call between observation and action.

**Run one Chromium window or process per tab.** Rejected because tabs already provide isolated renderers and histories while preserving one SSO profile; separate windows are reserved for separate agent owners and independent profiles.

**Allow same-tab actions to overlap.** Rejected because each action's trailing PageController snapshot replaces that tab's valid element indices, so mutations based on one observation must remain ordered.

## Consequences

An agent can operate two or more controlled tabs in one model step when every call names a different `tab_id`. Each tab adds a live renderer, while only the selected tab is visible; background actions remain observable through their tab-labeled results rather than simultaneous on-screen views.

One agent still owns one Chromium profile and window. Work requiring independent cookies, profiles, or windows uses separate agents rather than another browser-session abstraction.

## Testing

The service test holds two explicit-tab actions until both reach the same child, proving cross-tab overlap, single-window launch, and per-tab routing. Focused tool tests pin scheduler classification, `tab_id` forwarding, and the trailing same-tab state read. The knowledge-recorder test interleaves two tab histories and proves that only same-tab observations form a transition. The real-Electron suite reads a background tab while another remains selected and addresses both tab preloads concurrently; its native chrome test covers add, select, close, Back, Forward, zero-tab dismissal, and reopening through page observation, new-tab navigation, and user URLs. The desktop smoke checks the renderer's panel dismissal and agent-driven restoration.

## Related

The native chrome isolation decision remains in [Embedded browser chrome](2026-08-22-embedded-browser-chrome.md). Chromium-compatible SSO navigation remains in [Chromium-compatible embedded browser navigation](../architecture/2026-08-22-unrestricted-embedded-browser-navigation.md).
