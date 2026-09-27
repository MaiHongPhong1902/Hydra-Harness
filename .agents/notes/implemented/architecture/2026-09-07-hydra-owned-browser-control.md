# Agent Note: Hydra-owned browser control

Status: implemented

## Problem

Every `browser_*` result can put up to 16k characters of text DOM into the session log, then resend that dump on every later turn. Ordinary click/type/scroll work therefore costs O(n²) tokens. The vendored PageAgent ReAct loop looks like a shortcut for that work, but it is a second LLM on the same model plus poll-and-dump of the same 16k snapshot, so it is both worse at the task and more expensive. Index assignment also changes after every action, so Hydra cannot batch by index, and the native chrome did not open or report agent activity when a tool drove the page.

## Decision

Hydra is the only reasoning loop. The locally owned BrowserAgent source provides PageController: a numbered text DOM and indexed or named clicks, typing, and scrolls. `third-party/browseragent/` keeps the upstream APIs and attribution while carrying Hydra's mask changes. `browser_page_agent_run` remains an explicit tool and is demoted in the prompt; Hydra is not told to poll it. `PageAgentCore` is constructed only when that tool runs.

`@hydra/harness-tool-browser` returns a full snapshot only for `browser_state` and `browser_navigate`. Every other action result is compact: the Hydra preload ranks `*[` lines, then typical form controls, then the rest, without changing PageController indices; the consumer cuts that ranked list to 4k characters, shortens the header, and uses a one-line tab summary when only one tab is open.

Hydra-owned PageController actions close the index-churn gap without a second model: `browser_find` matches a visible name and may scroll internally; click/type/select accept `name` as well as `index`; `browser_fill` types several fields in one call and re-resolves each field after the previous one; `browser_forward` is a first-class tool beside `browser_back`.

The first agent page action reveals the desktop Browser panel. Native chrome follows the desktop light/dark theme and shows an agent status line, HTTPS lock, loading spinner, tab favicons, and PageController index highlights (`highlightOpacity` / `highlightLabelOpacity` on the public PageController config). Hydra's preload hit-tests through those highlights and the simulator mask, rejects an indexed click whose center is covered by another page element, and follows a matched label to its control. The upstream PageAgent Panel is not embedded in the webpage.

This does not reverse the text-DOM decision in [embedded-browser-page-agent](../feature/2026-08-22-embedded-browser-page-agent.md).

## Alternatives considered

**PageAgentCore as the default executor.** Rejected: it is a second agent on the same model, adds poll latency, and still dumps a full snapshot into Hydra's session log whenever Hydra checks status. The inner loop never enters the session, but the outer poll does, so the default path would be more expensive than Hydra-owned indexed tools.

**Moving ranking and name resolution into PageController.** Rejected: ranking, name resolution, find, and fill belong in the Hydra preload wrapper. The local BrowserAgent copy owns only the DOM controller and mask runtime.

**Screenshot-as-control.** Rejected on the same cost and precision grounds as the original text-DOM decision: vision tokens, a vision-capable model as a hard requirement, and no stable name for one of two identical buttons.

**One `browser_*` schema with a `method` enum.** Rejected: the per-tool schemas document distinct arguments (`name` vs `index`, fill fields, find query) and keep presenters pure over those arguments.

## Consequences

A long browsing run still produces a fresh, differently numbered list after every action, but ordinary actions no longer append a 16k dump to the session. The model must call `browser_state` when a control is missing from the compact list.

Name resolution and fill re-index after `updateTree`, so a `name` is valid across one autocomplete refresh where a stale index is not. An index from the previous result remains the address for an index-only call; Hydra must not mix a previous index with a post-`updateTree` name lookup in the same call.

`PageAgentCore` idle cost is gone on tabs that never run `page_agent_run`. The explicit tool still exists for a user who asks for the upstream engine.

Native chrome height is 96px to fit the status row. Desktop `openBrowser()` runs on the first agent page method, not only on a user-opened URL. Isolated-world link clicks update `window.history` even when Electron's `navigationHistory` does not; agent `back`/`forward` follow the document session.

## Testing

Package tests cover compact vs full snapshots, ranking, named click validation, and find/fill/forward forwarding. Real Electron tests drive named type/fill/click, find, and forward against the form fixture, and the chrome-ui driver asserts the agent HUD and panel reveal. The ACP `browser-tool-turn` snapshot pins the updated schemas and prompt.

## Related

Ownership, text DOM, and Electron process shape remain in [embedded-browser-page-agent](../feature/2026-08-22-embedded-browser-page-agent.md). Visual mask behavior remains in [embedded-browser-visual-automation-mask](../feature/2026-08-24-embedded-browser-visual-automation-mask.md).
