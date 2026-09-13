# Agent Note: Desktop terminals retain their owning workspace

Status: implemented

## Problem

The desktop launch directory can differ from the workspace containing the active conversation. Starting a terminal there sends relative commands to the wrong project. Reusing the bottom terminal across workspaces also exposes another project's shell as the current workspace's terminal.

## Decision

Terminal tabs capture the selected workspace ID at creation. The Electron start handler resolves that ID through the registered workspace list and uses its canonical root as the PTY working directory. Split panes and restarts inherit the tab's workspace. A live terminal rejects a start request from a different workspace; an unavailable registered directory fails startup. Only workspace-free terminals use the desktop launch directory.

The bottom panel retains one terminal group per visited workspace, mounting each group when first opened and hiding it on workspace switches. Returning restores its output and shell state. Bottom PTY IDs include workspace, tab, and optional split ordinals so tabs and panes cannot collide across workspace groups. The shared tab host preserves selection and pane layout within each group.

The [panel lifecycle decision](2026-09-08-side-panel-keyboard-and-state.md) and [split and quote decision](../feature/2026-09-09-desktop-terminal-quote-split-and-sidebar.md) remain active: per-ID serialization, independent processes, and annotation routing apply within these workspace owners.

## Alternatives considered

**Change directory whenever the selected workspace changes.** Injecting a shell command can interrupt a running program or alter a terminal the user deliberately navigated elsewhere. Capturing ownership preserves those processes and directories.

**Send an arbitrary renderer path.** The existing registered-workspace resolver supplies the authoritative directory and rejects stale IDs without duplicating file-panel validation.

## Consequences

New shells start in their owning workspace even when Hydra launches elsewhere. Hidden bottom groups retain their processes and output until stopped or the desktop exits. Right tabs retain their creation workspace when the active conversation changes.

Component checks cover A/B/C selection, returning to an existing bottom group, and splitting an older tab. The real Electron smoke checks PowerShell working directories through the preload bridge and rejects missing or mismatched workspace IDs.
