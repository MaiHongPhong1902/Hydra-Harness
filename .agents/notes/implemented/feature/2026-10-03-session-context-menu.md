# Agent Note: Session context actions and sidebar organization

Status: implemented

## Problem

Session management needs direct access from a row and stable organization across browser reloads. Directory-backed Workspace accounts cannot move an existing session to an unrelated directory without changing its execution environment.

## Decision

[Session rows](../../../../packages/client/ui-workspace/src/client/rows/Rows.tsx) open the same action menu through right-click, Shift+F10 and the overflow button. [The viewing store](../../../../packages/client/ui-workspace/src/client/stores.ts) retains pins, unread markers, custom sections and display-project assignments. Opening a row clears its explicit unread marker. Pins take precedence over custom sections, and organized rows appear once in grouped and flat views. Older persisted viewing state remains valid because the added fields are optional and acquire defaults when read or mutated.

[Display-project projection](../../../../packages/client/ui-workspace/src/client/organization.ts) changes sidebar grouping only. The Host retains directory accounts and the session retains its original working directory. Deleted display projects fall back to Host membership; display-only moves never send directory-account reorder RPCs. The orphan-deletion action still resolves actual Host membership.

[Markdown copy](../../../../packages/client/ui-workspace/src/client/session-markdown.ts) reads all history pages without selecting or resuming the session and copies committed user and assistant text. It omits reasoning, tool payloads, injected context and model-only replacements. Failed or stalled pagination rejects the copy. Session links carry a session query parameter and select that id after the list baseline loads. Desktop opens those links in an isolated Web window without native panel privileges.

Share is disabled with Coming soon copy. Worktree forking is disabled with an explicit Host capability explanation. Ordinary forking, archive and confirmed permanent deletion retain their existing owners.

## Alternatives considered

**Moving directory accounts for sidebar organization** would invalidate the Host's immutable cwd checks or silently change where subsequent tools execute. Browser viewing state carries the organization choices instead.

**A separate context-menu implementation** would duplicate dismissal, placement and nested-menu behavior. The shared Menu supports shortcuts, arrow navigation and viewport-clamped fixed submenus.

## Consequences

Organization survives reload on the same browser profile and does not synchronize across devices. The execution directory remains visible through Copy working directory even after a display-project move. Additional Desktop windows use the Web interface; native Files, Terminal and embedded Browser controls remain in the main window.
