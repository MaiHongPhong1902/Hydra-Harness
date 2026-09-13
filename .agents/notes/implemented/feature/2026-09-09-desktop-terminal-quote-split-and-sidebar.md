# Agent Note: Desktop terminal quote to chat, split panes, and process management sidebar

Status: implemented

## Problem

Desktop users working with Hydra agents frequently need to interact with terminal sessions alongside conversation chats. Previously, the desktop terminal panel was limited to a single rigid PTY instance per panel side without selection quoting into chat, split layouts, or process tracking:
1. Users could not quote selected terminal output into the active chat session (analogous to the browser panel element annotation card workflow).
2. Users could not split or run side-by-side terminal panes within the panel.
3. Users had no visibility or control over running terminal processes created within their Hydra sessions (e.g. powershell.exe or shell instances).

## Decision

We redesigned DesktopTerminalPanel and extended desktop preload and IPC bridges:

1. **Quote Selection to Chat (Ctrl+L)**:
   - Integrated with @xterm/xterm selection events (onSelectionChange, getSelection).
   - When text is selected, a floating pill popover (Quote Ctrl+L) is positioned above the selection range.
   - Triggering the quote action (via clicking the pill or pressing Ctrl+L in xterm) formats a browser-element annotation and dispatches it through window.hydraDesktop.browser.emitAnnotation().
   - In ui-conversation, apply.ts intercepts this annotation and adds it directly as a quote/reference card in the active session message composer.

2. **Split Terminal Panes**:
   - SingleTerminalPane encapsulates individual xterm instances, PTY lifecycle, and FitAddon resizing.
   - Both panel placements share a tab host. The header + button creates an independent terminal tab; the process sidebar Split Terminal button divides that tab into side-by-side panes. Bottom IDs include workspace and tab ordinals before the split ordinal (`bottom-1-2-2`); right splits retain their tab ordinal (`right-1-2`, `right-4-2`).
   - main.cjs terminal ID validation supports multi-segment split IDs while rejecting zero/invalid ordinals, ensuring all processes run in independent, isolated PTY sessions without collisions across tabs.

3. **Hydra Process Management Sidebar**:
   - A collapsible right-side drawer lists running terminal processes strictly scoped to Hydra sessions (never external system processes).
   - Terminals are grouped under Conversations -> Session Title (e.g., active session title or current conversation).
   - Each process row displays the process name, a split button, and a kill/terminate button.
   - The sidebar can be shown or hidden via a header toggle button.

## Alternatives considered

**Separate bottom tab implementation**: Reusing the right panel tab host keeps keyboard navigation, focus transfer, close failures, and PTY preservation consistent across placements.

**External OS Process Management**: Scanning all OS processes using tasklist or ps. Rejected because security and scoping invariants dictate that Hydra only manages processes spawned by Hydra or by the user inside Hydra harness.

**Custom Chat Quote Protocol**: Inventing a new IPC channel specifically for terminal quotes. Rejected because reusing the existing browser annotation pipeline allows seamless integration with existing composer cards without modifying the chat parser or wire protocols.

## Consequences

Terminal sessions can now be split into multiple side-by-side panes, each running an independent PTY process with isolated output and fit handling. Text selected in any pane can be quoted into the active session composer with one click or Ctrl+L, providing symmetry with the browser annotation experience. The sidebar exposes direct visibility and termination controls for all Hydra terminal processes while remaining collapsible to preserve screen space.

## Testing

- Unit tests in packages/client/ui-layout/tests/desktop-panels.client.spec.tsx:
  - Verified header controls (title, project button, new terminal, sidebar toggle).
  - Verified splitting terminal into multiple panes, monotonic sub-pane ID generation across embedded tabs (`right-4-2`, `right-4-3`), avoiding collisions with tab 2 (`right-1-2`), and killing panes.
  - Verified selection popover appearance, clicking Quote Ctrl+L, and emitting browser annotations.
  - Verified process sidebar collapsible grouping and process rows.
  - Verified split pane cleanup on panel unmount.
- Smoke tests in apps/desktop/main.cjs:
  - Verified valid multi-segment split terminal ID (`right-4-2`) is accepted and starts.
  - Verified invalid split terminal ID (`right-4-0`) is rejected.
- Full suite tests in packages/client/ui-layout/tests/ pass cleanly (124 tests across 9 test files).
