# Agent Note: Antigravity file review UI

Status: implemented

## Problem
File modifications and edits made by the agent previously rendered as minimal text diffs without line numbers, status badges, or diff copy options. In the review panel, users could not easily filter changes by path or status, nor could they perform bulk actions like Keep All or Undo All when many files were modified.

## Decision
Upgrade `@hydra/harness-client-ui-review` (`Review.tsx` and `Review.module.css`) to provide an Antigravity-grade interactive diff and file change review experience:
1. **Line-numbered Unified Diff View**: Computed old and new line numbers from hunk headers (`parseHunkNumbers` and `processHunk`) rendered in a dedicated two-column gutter (`.lineGutter`) using CSS `::before` and `::after` pseudo-elements. This preserves exact DOM `textContent` for existing test contracts while providing a professional, tinted visual gutter.
2. **File Change Cards**: Added badge pills for change status (`A` for Added, `M` for Modified, `D` for Deleted), stat counters (`+X -Y`), and state badges (`Kept`, `Undone`, `Pending`).
3. **Per-file Copy Diff**: Added a 1-click "Copy diff" action with a 1.5-second visual "Copied!" confirmation.
4. **Review Panel Filtering and Batch Actions**: Added a file path search filter, status filter tabs (`All`, `Pending`, `Kept`, `Undone`), and batch action buttons (`Keep All` and `Undo All`) with appropriate disabling when changes are in progress or non-reversible.

## Alternatives considered
- **Rendering line numbers as inline text elements**: Breaks existing DOM test contracts where `.textContent` asserts raw hunk strings like `' context\n-A\n+B'`. Using CSS `content: attr(data-old)` and `content: attr(data-new)` keeps textContent intact.
- **External Monaco diff editor**: Overkill for inline review in chat tool cards and introduces heavy bundle dependencies. Lightweight CSS-driven unified diffs provide fast, portable rendering across web and desktop.

## Consequences
Users have clear visual line numbers, additions/deletions diff styling, and instant file filtering/batch approval in both inline chat tool cards and the desktop review panel.

## Verification
- Unit tests in `packages/client/ui-review/tests/review.client.spec.tsx` verify batch actions (Keep All, Undo All), search filtering, status tab filtering, and line diff rendering.
- Workspace typecheck (`pnpm run typecheck`) and Vitest test suite (`pnpm --filter @hydra/harness-client-ui-review test`) pass with zero regressions.
