# Agent Note: Desktop Files follows the active Workspace

Status: implemented

## Problem

The Electron Files bridge fixed its root to the desktop launch directory, so `Ctrl+P` could show the source or installation tree instead of the Workspace selected in the client. The Files panel also lacked complete-Workspace search and the basic Explorer and editing actions implied by its VS Code-like surface.

## Decision

`AppFrame` derives the active registered Workspace id from the current Session and the reactive Workspace list, falling back to the recent Workspace when no Session is selected. `DesktopFilesPanel` sends only that opaque id; Electron resolves its canonical path through Host `workspace.list` before every Files operation. With no registered selection, Files stays empty rather than exposing the desktop launch or installation tree.

The Explorer provides inline new-file and new-folder forms for the selected directory, refresh, recursive substring search, and lightweight code, data, web, and text icons. `Ctrl+P` selects the persistent Files tab and focuses its native search input; Electron dispatches panel shortcuts only for `keyDown`, and late Session initialization does not steal focus from another text field. Search uses Node's filesystem glob, skips `.git`, `node_modules`, and symlinks, re-confines results, and stops at 200 files.

Selecting an eligible text file opens a controlled textarea editor. A pointer-inert Shiki layer behind the textarea colors supported filename extensions through the existing theme tokens, while the textarea remains the only editable and accessible text surface. The editor groups icons by filename extension, marks drafts that differ from the last read or saved content, formats through Prettier with `Shift+Alt+F`, and saves with `Ctrl+S`. Formatting changes only the draft. Saving uses the version returned by read, serializes writes per canonical path, publishes atomically, preserves the original POSIX mode and UTF-8 BOM, emits the draft with the file's dominant line ending, and leaves a stale draft visible when the file changed externally. The latest document state arbitrates asynchronous reads, creation, formatting, and saving so a delayed response cannot replace a newer draft. Opening another file, closing the Files tab, and switching Workspace require confirmation before dirty content is discarded; a pending save blocks those transitions until it settles.

Every list, search, create, read, format, and save IPC call validates the renderer sender, re-resolves the registered Workspace, and confines canonical paths to that root. Entry creation accepts one trimmed leaf name, rejects separators, traversal names, NUL, and Windows-forbidden characters, and uses non-overwriting filesystem operations. Reads and writes reject binary, invalid UTF-8, NUL-containing, and larger-than-1-MB content; symlink rows and traversal remain excluded.

## Alternatives considered

**Trust a renderer-supplied root path.** Rejected because the Electron IPC handler owns local-file access and must not let a compromised renderer widen that access to an arbitrary directory. Resolving an opaque Workspace id through the Host preserves the registry as the path authority.

**Use `process.cwd()` as the Files root.** Rejected because the desktop process working directory does not change when the user switches Workspace and packaged launches may start outside any project.

**Embed VS Code or Monaco.** Rejected because the requested Explorer, editing, formatting, and safe-save workflow fits the existing desktop panel without shipping a second editor runtime. Monaco becomes justified when syntax services, diagnostics, or multi-document editor tabs are product requirements.

## Consequences

Files follows Workspace selection and `Ctrl+P` reaches a searchable, syntax-colored project view. A dirty Files surface retains its previous Workspace until the user saves, reverts, or confirms discard. The implementation remains intentionally bounded: it uses a native textarea rather than Monaco and has no per-file editor tabs, language diagnostics, or persisted multi-document buffers. Unsupported extensions remain plain text. Substring matching is not fuzzy ranking, and large result sets stop at the documented bound. Path confinement and version comparison reject stable escape and stale-write attempts but cannot form an operating-system sandbox or an atomic compare-and-swap against an external process that replaces a junction or file during the final pathname operation; crash durability and Windows DACL preservation are also outside the atomic-write helper's guarantees.

## Verification

The AppFrame, desktop-panel, and InputBar component specs pin current-Workspace routing, `Ctrl+P` selection and focus, focus preservation during Session initialization, recursive search, file icon groups, inline creation, syntax-token colors, editing, formatting, versioned saving, dirty confirmation, save-transition blocking, asynchronous read and create interleavings, and stale-response preservation. The Electron desktop smoke registers an isolated Workspace, sends real `Ctrl+P`, asserts the exact canonical root, creates entries, formats and saves a fixture, preserves text metadata, rejects stale and concurrent overwrites plus invalid or oversized content, excludes an outside directory symlink, rejects an unscoped root request, and rejects paths outside that Workspace.
