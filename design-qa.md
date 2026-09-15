# Design QA — Event details panel modes

Reference: `C:\Users\map7hc\AppData\Local\Temp\codex-clipboard-c4bf2d0f-7c35-4704-bfff-7ef3dc4f781d.png`

Implementation: `http://127.0.0.1:3080/`, saved session → Trajectory → selected
tool event → Event details.

The reference crop and a live crop of the implemented controls were reviewed
together in the same comparison input. The live application was using its light
theme, so color follows the current design tokens while icon order, geometry,
active treatment, and behavior follow the dark reference.

## Findings

| Severity | Result |
| --- | --- |
| P0 | None |
| P1 | None |
| P2 | None |

## Verified

- Controls use the existing icon library in the reference order: expand, bottom,
  right.
- The active mode has a rounded bordered treatment and an accessible pressed
  state.
- Right mode keeps the existing vertical inspector and resize handle.
- Bottom mode places the same inspector below the trajectory and clears the
  floating composer.
- Expanded mode keeps the sidebar while giving the inspector the full trajectory
  content area.
- Switching modes preserves the selected event, active tab, and inspector DOM.
- The 1139 × 912 live viewport was checked in all three modes.

## Verification evidence

- `pnpm exec vitest run packages/client/ui-trajectory/tests/views.client.spec.tsx packages/client/ui-trajectory/tests/table.client.spec.tsx`: 60/60 passed.
- `pnpm exec tsc -b tsconfig.client.json`: passed.
- `pnpm exec oxlint` on the changed TS/TSX files: passed.
- `pnpm run build`: passed after the panel implementation.
- `pnpm run build:lib:client` and `pnpm run build:web`: passed after the final
  bottom-clearance adjustment.

final result: passed

---

# Design QA — Codex-style right panel switcher

Reference: `C:\Users\map7hc\AppData\Local\Temp\codex-clipboard-6409b7d6-1916-4613-97f5-5cb5e5d67171.png`

Implementation screenshot: `C:\Users\map7hc\AppData\Local\Temp\hydra-right-panel-switcher.png`

Combined comparison: `C:\Users\map7hc\AppData\Local\Temp\hydra-right-panel-comparison.png`

State: Hydra harness desktop, light theme, 1425 × 893 window, Browser and Terminal
open together, right-panel chooser open. The focused implementation crop and
the 768 × 278 reference were compared at 1:1 pixel scale; both use 536 × 40
rows with 4 px gaps.

## Findings

| Severity | Result |
| --- | --- |
| P0 | None |
| P1 | None |
| P2 | None |

## Fidelity surfaces

- Component geometry: four-row switcher, row height, spacing, radius, horizontal
  padding, icon alignment, label alignment, and trailing pill positions match the
  reference.
- Typography and icons: existing Hydra harness font tokens and icon library are used;
  no approximate SVG or CSS-drawn assets were introduced.
- Color: the implementation intentionally follows the active light-theme tokens;
  the dark-theme reference supplies structure and state treatment, not a forced
  theme override.
- Interaction: Browser and Terminal are real independent panels. Opening the
  chooser hides the native Browser WebContentsView; choosing Terminal closes the
  chooser and restores Browser while Terminal remains open.
- Accessibility: the chooser is a labeled dialog; enabled rows expose pressed
  state and keyboard shortcuts; unavailable rows are native disabled buttons.

## Product constraint

Files and Side chat remain disabled and display `Coming soon` because this build
does not yet own a real file explorer or independent side-chat surface. They were
not wired to unrelated existing views or presented as functional shortcuts.

## Comparison history

1. Source inspection established the four 536 × 40 rows, 4 px gaps, compact
   shortcut pills, and centered right-panel placement.
2. The final live Electron state was captured after Browser/Terminal simultaneous
   behavior passed. The combined 1:1 comparison found no P0–P2 mismatch, so no
   visual correction pass was required.

## Verification evidence

- `pnpm exec vitest run packages/client/ui-layout/tests/desktop-browser-panel.client.spec.tsx packages/client/ui-layout/tests/app-frame.client.spec.tsx`: 28/28 passed.
- `pnpm run build`: passed.
- `pnpm --filter @hydra/harness-desktop run smoke`: passed with chooser, app-wide
  shortcut, simultaneous panel, expand, and restored-bound checks.
- `pnpm run verify-third-party-notices`: passed.
- `git diff --check`: passed.

final result: passed

---

# Design QA — Right-panel workspace tabs

References:

- `C:\Users\map7hc\AppData\Local\Temp\codex-clipboard-f889d4d7-610e-4872-89e5-7d4fe85cc1a7.png`
- `C:\Users\map7hc\AppData\Local\Temp\codex-clipboard-49b62002-0203-4e26-8887-1b413675e05e.png`

Implementation screenshot: `C:\Users\map7hc\AppData\Local\Temp\hydra-right-panel-live.png`

Combined comparison: `C:\Users\map7hc\AppData\Local\Temp\hydra-right-panel-comparison.png`

State: Hydra harness Electron desktop, light theme, 1920 × 1032 window. Files was
active with the `Hydra-Harness` workspace tree and `package.json` preview;
Browser, two independent Side chat sessions, and right Terminal remained in the
tab strip while the bottom Terminal was open.

## Findings

| Severity | Result |
| --- | --- |
| P0 | None |
| P1 | None |
| P2 | None |

## Verified

- The right panel follows the reference tab-host layout and current theme tokens.
- Every Side chat action creates another real session (`Side chat`, `Side chat 2`)
  without replacing the main conversation.
- Files lazily opens the current desktop workspace tree and previews real text
  files; traversal and binary/oversize reads stay blocked in the main process.
- Right Terminal and bottom Terminal are separate PTYs and remain open together.
- Right-panel width was dragged from about 600 px to its 720 px maximum; resize,
  expand, restore, close, and reopening behavior preserves the mounted tab state.
- Native Browser views are visible only while the Browser tab is active, so they
  do not cover Files, Side chat, Terminal, or the chooser.

## Verification evidence

- Combined reference/implementation review found no P0–P2 visual mismatch.
- Live Electron interaction verified Files, two Side chats, dual terminals, and
  panel resizing.
- Focused Vitest suite: 35/35 passed.
- TypeScript contract check and full build: passed.
- Targeted oxlint and Electron main/preload syntax checks: passed.
- Electron smoke: passed with one window, isolated right/bottom PTYs, native
  Browser hide/restore, resize, expand, and restore checks.

final result: passed
