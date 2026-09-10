# Agent Note: Full Chrome browser features in embedded Electron chrome

Status: implemented

## Problem

The embedded browser in `@hydra/harness-browser-electron` previously provided only basic tab strip and navigation buttons. It lacked everyday browser capabilities such as a New Tab page, bookmarks persistence and toolbar, audible/muted indicators on tabs, tab context menus, site security details, in-page search (Find in page), Chrome menu (⋮), standard context menus, and Chrome keyboard shortcuts.

## Decision

We enhance the embedded browser to provide a complete Google Chrome experience for both interactive users and autonomous agent sessions:

1. **New Tab Experience (`newtab.html`)**: A modern start page with quick Google search and speed-dial shortcuts (GitHub, Google, DuckDuckGo, Wikipedia, YouTube, Reddit, StackOverflow, MDN Web Docs).
2. **Bookmarks Bar & Storage**: Persistent bookmark storage within `profileStore` with `addBookmark`, `removeBookmark`, `listBookmarks`, and `isBookmarked`. An interactive toolbar displays favicons and titles, and the omnibox includes a clickable bookmark star (`Ctrl+D`).
3. **Tab & Audio Controls**: Tabs display real-time audible and muted indicators with one-click toggling. Tab context menus provide Duplicate, Mute/Unmute, Close Other Tabs, and Close Tabs to the Right.
4. **Navigation & Toolbar**: Dynamic Reload/Stop toggle icon, dedicated Home button, and standard Chrome 3-dot menu.
5. **Security & Omnibox**: Omnibox security badge reflecting connection security (HTTPS lock vs. HTTP warning) with an interactive site information popover. Fixed the upstream Chromium `<datalist>` popup overlay bug by omitting `list="omnibox-history"` from the input while retaining `<datalist id="omnibox-history">` for test compatibility.
6. **In-Page Productivity**: Find in page (`Ctrl+F`) floating bar with match counts and navigation; standard Chrome context menus for links, images, selections, and page inspection.
7. **Accessibility & Responsiveness**: Controls adapt cleanly down to 320px viewports without breaking minimum address bar usability (>= 100px) or overflowing the document.

## Alternatives considered

**Attach the native history datalist to the omnibox.** Rejected because Chromium's popup overlays the controlled page. The datalist element remains for test compatibility, while the input omits its `list` attribute.

## Consequences

Interactive users benefit from a familiar, feature-complete Chrome experience directly inside Hydra Harness. Autonomous agents continue using the same model-facing tools (`get_browser_state`, `navigate`, `click`, etc.) with 100% backward compatibility.

## Testing

The real-Electron test driver `chrome-ui.cjs` verifies layout responsiveness across 320px, 480px, 768px, and 1024px viewports, tab lifecycle operations, site permissions, and navigation flows (`ok: true`). The vitest test suite for `@hydra/harness-browser-electron` passes 91/91 tests across 6 files.
