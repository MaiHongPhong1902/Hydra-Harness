# Agent Note: Browser test fixture modernization, standalone extraction, and chrome UI annotation icon

Status: implemented

## Problem

The embedded Electron browser test fixtures (`form.html`, `hidden-upload.html`, `next.html`) and several inline HTTP responses (`/autofill`, `/policy`, `/selection.html`, `/spa`) in `tests/electron.spec.ts` were unstyled raw HTML documents lacking visual realism and consistent layout structures. Hardcoding multi-line HTML strings directly in the test file made the fixtures difficult to inspect, debug, and preview in isolation.

Additionally, the default `newtab.html` start page in `electron-app/` was a minimal bare prototype page rather than a cohesive dark-themed launch experience, and the annotation button (`#annotate`) in `electron-app/chrome.html` used a raw Unicode character (`⌖`), which rendered with inconsistent font fallbacks, blurry edges, and chromatic aberration compared to adjacent vector SVG navigation icons.

## Decision

### Standalone fixture extraction

Extracted inline fixture HTML strings from `packages/browser/browser-electron/tests/electron.spec.ts` into dedicated fixture files under `packages/browser/browser-electron/tests/fixtures/`:
- `autofill.html`: login credentials and contact form fields with `autocomplete` attributes.
- `policy.html`: cross-origin links and popup anchors using a configurable `__CROSS_ORIGIN__` placeholder.
- `selection.html`: exact coordinate monospace inputs, textarea, text elements, multiline buttons, and password fields.
- `spa.html`: dynamic single-page application hydration with delayed title update and button mount.

Updated `fixtureServer` in `electron.spec.ts` to load these files from disk via `readFileSync` instead of inlining strings.

### Fixture modernization with strict DOM invariants

Modernized `form.html`, `hidden-upload.html`, `next.html`, `autofill.html`, `policy.html`, `selection.html`, and `spa.html` using the Hydra Dark palette (`#0f172a`, `#1e293b`, accent cyan/indigo), status badges, and cards while preserving every existing DOM invariant:
- Retained all element IDs, form control names, accessibility roles, and label bindings required by automated tests.
- Avoided CSS pseudo-element `content` on interactive elements to prevent Chromium accessible name mutation (e.g. keeping accessible name `"Continue"` rather than `"Continue→"`).
- Maintained exact font dimensions (`font: 20px monospace`), container widths, zero padding, zero margin, and absolute positioning in `selection.html` to guarantee subpixel caret selection snapping remains under 0.01px error.
- All styles and assets remain 100% self-contained and inline without CDN or external network dependencies.

### Chrome UI and New Tab modernization

Modernized `packages/browser/browser-electron/electron-app/newtab.html` into a Hydra start page with a radial background gradient, glowing omnibox card, quick links grid, and keyboard shortcuts reference.

Replaced the raw Unicode character (`⌖`) in `packages/browser/browser-electron/electron-app/chrome.html` with a crisp 100% vector SVG crosshair reticle matching the 14x14 viewport, 2.2 stroke width, and slate color styling of adjacent toolbar buttons (`#find-toggle`, navigation buttons). Preserved the `<button id="annotate">` tag, accessibility attributes, and disabled state.

## Alternatives considered

- **Keep fixtures as inline JavaScript strings in `electron.spec.ts`**: Rejected because inlined HTML obscures test logic, prevents standalone browser preview, and makes visual verification cumbersome.
- **Use an external CSS library (Tailwind/Bootstrap CDN)**: Rejected because all test fixtures and internal browser pages must run completely offline in hermetic environments with zero external network requests.
- **Font icon or canvas for annotation reticle**: Rejected because inline vector SVG provides zero-latency rendering, crisp scaling at all DPI levels, and inherits currentColor directly without extra asset loading.

## Consequences

Test fixtures present realistic visual layouts for human inspection and visual regression testing while maintaining complete backward compatibility with all existing Playwright and CDP automation queries. The browser chrome UI toolbar displays uniform, crisp vector icons across all platforms.

## Testing

Verified with `vitest run packages/browser/browser-electron/tests/electron.spec.ts` and `vitest run packages/browser/browser-electron/tests/service.spec.ts`. Subpixel selection coordinates, file uploads, form submissions, and toolbar button clicks pass with zero regressions. All files verified clean with `git diff --check`.
