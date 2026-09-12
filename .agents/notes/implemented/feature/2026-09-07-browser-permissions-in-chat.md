# Agent Note: Browser website permissions in chat

Status: implemented

## Problem

Native website permission dialogs interrupt the conversation and block Electron while the user decides whether the agent may continue.

## Decision

Camera/microphone requests use the owning agent's user-questions provider. The existing chat composer presents Allow once, Always allow, and Block. Electron retains authority over exact-origin media policy and persisted decisions; missing answerers, skipped answers, custom text, disconnection, cancellation, and document replacement deny the pending operation. [Global Browser permissions](2026-09-11-global-browser-permissions.md) supersedes the website navigation question flow with execution approvals and independently controls downloads and uploads.

Electron holds the main-frame network callback while awaiting navigation approval in chat. This preserves the original request, including POST bodies, through links, redirects, and programmatic navigation. Reissuing an intercepted URL as a GET would change what the user approves. Action and startup deadlines pause while a permission request is pending and resume after its resolution. Cancellation and owner disposal also stop startup while the home page awaits permission. Requests are not transferred to a different browser owner.

The native toolbar adapts to narrow panels and scrolls overflowing tabs. PageController's numbered boxes are hidden in the isolated preload stylesheet; text indices, automation, the simulator cursor, and explicit annotation selection remain available. The gradient is visible only while browser commands are pending; completion and failure clear it after the last overlapping command ends. Manual browsing keeps the virtual cursor without the gradient or an input-blocking mask.

This extends the permission presentation described by [desktop browser settings](2026-08-26-desktop-browser-settings.md); that note remains the owner of settings, download policy, and browser managers.

## Alternatives considered

**Add a separate desktop permission dialog component.** The existing user-questions service already binds a question to the owning chat and provides reply, cancellation, and reconnect handling.

**Approve only explicit browser tool calls.** Page links, redirects, and popups can navigate independently of the original tool, so Electron must enforce the decision at the actual request.

**Replay a blocked navigation after approval.** Replaying only its URL discards POST bodies and changes navigation semantics.

## Consequences

The browser remains responsive during human decisions. Unowned page navigation under an ask policy fails closed; [direct native chrome navigation](../bug-fix/2026-09-12-omnibox-navigation-without-chat-owner.md) remains under the user's control for its full navigation chain. Users can configure global Browser permissions in Settings. Downloads use the owning conversation's execution approval. Screenshot prompts and elevated-risk settings confirmations retain their native presentation.

Real Electron checks cover request blocking, exact-site persistence, cancellation, narrow toolbar dimensions, and page viewport resizing. The assembled web scenario exercises the Browser service through its child protocol and answers the resulting question in chat. Child-process checks cover paused deadlines and missing or cancelled answerers.
