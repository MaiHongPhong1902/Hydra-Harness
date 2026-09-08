# Agent Note: Deep workspace file management and multi-document editor

Status: implemented

## Problem
The Desktop Files panel previously permitted only single-document editing with a basic textarea that lacked line numbers, editor status telemetry (cursor Ln/Col, line/character count, line endings, language), or unsaved diff inspection. File operations were limited to creation, with no affordances for renaming or deleting files and directories, context-menu actions, or copying paths.

## Decision
1. **Multi-Document Tabs**: Extended `DesktopFilesPanel` to maintain an active tab set (`openDocuments`) with tab switching, dirty indicators, independent drafts, and close buttons (`✕`) with unsaved-change confirmation guards.
2. **Line Numbers Gutter**: Added a synchronized, sticky line-number gutter (`.lineGutter`) aligned with the monospace font and line-height of the code editor canvas.
3. **Editor Status Bar**: Added an informational bottom bar displaying live cursor position (`Ln X, Col Y`), total line count, character count, encoding (`UTF-8`), line endings (`LF`/`CRLF`), and file language pills.
4. **File Operations in Desktop Bridge**: Extended `apps/desktop/main.cjs` and `preload.cjs` with `rename`, `delete`, and `reveal` handlers confined strictly within the canonical workspace root.
5. **Context Menu & File Actions**: Added right-click context menus to tree rows offering New File, New Folder, Rename, Delete, Copy Path, Copy Relative Path, and Reveal in File Explorer. Added an inline rename form in the tree.
6. **Diff with Disk & Discard**: Added a toolbar "Diff" toggle comparing the current draft with disk contents using a clean line diff view, and a "Discard" button to safely revert unsaved edits.

## Alternatives considered
- **Embedding Monaco or CodeMirror**: Rejected to avoid heavy external bundle weight and runtime overhead; the lightweight textarea + Shiki highlight + line-number gutter provides high performance and native responsiveness.
- **Unconfined filesystem delete/rename**: Rejected because all file operations must remain strictly bounded by `confinedPath(root, target)`.

## Consequences
Desktop workspace file navigation and code editing now match modern developer workflows with tabs, line numbers, cursor telemetry, and complete file management operations.

## Verification
- Unit tests in `packages/client/ui-layout/tests/desktop-panels.client.spec.tsx` verify multi-document tabs, tab switching, closing tabs, rename and delete context-menu actions, line numbers gutter rendering, and discard actions.
- Existing suites in `packages/client/ui-layout/tests/desktop-browser-panel.client.spec.tsx` and across `packages/client/ui-layout/` (9 test files, 109 tests) pass with zero regressions.
- Workspace typecheck (`pnpm run typecheck`) and Biome checks pass with 0 errors.
