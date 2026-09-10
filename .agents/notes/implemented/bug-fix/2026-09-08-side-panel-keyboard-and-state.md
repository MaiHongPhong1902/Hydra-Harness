# Agent Note: Desktop side panel keyboard and state

Status: implemented

## Problem
The desktop right panel and the two column boundaries were mouse-first in ways that also broke keyboard and state handling. The tab strip was a tablist with every tab focusable, no arrow navigation, and no tab-to-panel association. Panel kinds were hidden behind an Add chooser, and a pending Side chat could take focus after the user selected another panel. Closing a right Terminal tab ran its stop through a state updater, which React can invoke more than once per dispatch. The sidebar and details resize handles carried keyboard-step code but were not focusable and received no step callback, so they were mouse-only.

## Decision
The right-panel tab strip uses roving tabindex and wraps ArrowLeft/ArrowRight with Home/End jumps; Delete closes the focused tab. Each tab names its surface through aria-controls/aria-labelledby and the surface carries role="tabpanel". The header keeps each panel option visible in a compact options row for one-click selection, and the empty state repeats those options as direct cards. Side chat creation ignores a late completion for focus when the user selected another panel while it was pending. Closing a tab reads the committed list, stops only that tab's Terminal PTY, leaves it open when stopping fails, and hands focus to the tab that takes over; closing the last tab empties the panel. The sidebar and details boundaries are focusable separators whose keyboard steps write through the layout store from the rendered width, so a concession-clamped column does not jump. The resolved app theme is passed to embedded browser chrome as a light/dark scheme and semantic palette; clearing it removes the renderer override so chrome follows Electron's OS preference. Terminal panels update xterm colors when the app theme changes without recreating their PTY or losing terminal output.

Native start and stop requests serialize per terminal ID, so a close waits for an in-flight startup and cannot leave its process unowned. Different terminal IDs proceed independently.

## Alternatives considered
A modal Add chooser was considered but skipped; visible options keep every destination one click away and avoid a second focus surface. Arrowing tab selection through the pending state was avoided because a singleton tab id equals its kind, so the selection needs no read of the pending list.

## Consequences
The right panel options, tabs, and both column boundaries are reachable and operable by keyboard. A pending Side chat does not replace a panel selected while its session is being created. Each right-panel Terminal tab owns a separate PTY and output; the bottom Terminal remains independent. Windows terminals use PowerShell. Terminal theme refreshes retain each panel's existing PTY and output. The tab stop count grows by one per column boundary in the web frame. A keyboard user cannot resize the sidebar or details while the corresponding column is collapsed, because the handles are not rendered then, matching the mouse path.

## Verification
The client specs pin direct panel-option selection, roving tab focus and wrapping arrow movement, tab-to-panel naming, late Side chat completion, independent right Terminal tabs and per-PTY stops, focus handover after a close, native Browser close handling, the empty state, and live terminal theme refresh with PTY preservation. AppFrame specs pin keyboard stepping and clamping for both column boundaries. Theme presenter and chrome UI specs pin the initial light/dark palette, scheme changes, disposal reset, and standalone OS fallback. The assembled file-review and web-citations browser scenarios pass in replay.
