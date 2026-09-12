# Agent Note: Direct omnibox navigation without a chat owner

Status: implemented

## Problem

The native omnibox routed user-entered addresses and searches through the chat navigation approval path. With no connected chat owner, the pending request was denied and Chromium reported `ERR_BLOCKED_BY_CLIENT`.

## Decision

Native browser controls and native page input while agent commands are idle put the tab under user control. HTTP(S) browsing then proceeds across links, redirects, popups, and history without agent navigation restrictions. The next agent command targeting the tab restores those checks before execution; agent-generated input does not grant user control. This separates user browsing from [unowned agent navigation denial](../feature/2026-09-07-browser-permissions-in-chat.md).

## Alternatives considered

**Keep the exact-URL approval.** Rejected because manual browsing includes redirects and further links without repeated chat approvals.

**Disable all Electron navigation checks.** Rejected because agent commands and their page navigation still need policy enforcement. The existing per-tab navigation state can distinguish user control from a Host approval.

## Consequences

Users can browse without an active chat connection or per-URL approvals. Native Electron coverage includes search, redirects under global and site blocks, user mouse input, subsequent page links, Back/Forward, Reload, and desktop link routing. Agent navigation and generated keyboard input remain restricted; an agent redirect still requires its own approval after user browsing.
