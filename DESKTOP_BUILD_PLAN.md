# BH Desktop Build Plan

## Goal

Ship BH as a Windows-first Electron desktop application while reusing the
existing React renderer and Host runtime. The browser UI remains the renderer
implementation, not the user-facing product shell.

Non-negotiable acceptance criterion: the controlled browser is embedded inside
the same application window. It must not open as a separate browser or Electron
window.

## Phase 1 — desktop layout foundation

- Keep the controlled browser mounted in the right panel and a real terminal
  mounted in the bottom panel. Let both panels open independently and at the
  same time.
- Let the browser expand over the main content area, then restore the previous
  browser and terminal open states.
- Keep the existing sidebar and conversation layout contracts intact.

Exit gate: focused layout tests cover independent right/bottom controls,
simultaneous panels, and browser expand/restore, followed by a visual check at
the supported viewport.

## Phase 2 — runnable desktop MVP

- Add a dedicated `apps/desktop` Electron shell; do not reuse the controlled
  PageAgent browser process.
- Start the existing Web profile internally with `--no-open --port 0`, wait for
  its readiness URL, and load that loopback URL in one `BrowserWindow`.
- Move the existing controlled-browser tab and PageAgent view ownership into
  the desktop shell. Attach each controlled page as a sandboxed
  `WebContentsView` under that same `BrowserWindow`; do not use an iframe.
- Use the renderer's right-panel and expanded state to update the active browser
  view bounds. Keep inactive tabs mounted but hidden so tab state and the shared
  Chromium SSO profile survive layout changes.
- Use `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`.
- Add narrow preload bridges for browser bounds/tab commands and terminal
  input/output/resize. Preserve sender validation and active-tab isolation.
- Shut down the internal Host process when the final application window closes.

The loopback server is an internal transport for the first desktop release. A
`file://` renderer plus IPC transport is a later migration only if removing the
local HTTP listener becomes a measured requirement.

Exit gate: Windows smoke tests prove startup, renderer boot, API requests,
simultaneous right-browser/bottom-terminal layout, browser expand/restore, tab
switching, PageAgent actions against the active tab only, terminal I/O, window
close, and clean Host shutdown without opening an external browser.

## Phase 3 — Windows package

- Add one packaging tool only when producing distributable artifacts.
- Produce an unpacked x64 build first, then an NSIS installer after smoke tests.
- Package the renderer dist, CLI runtime closure, profile configuration, and
  Electron preload into ASAR/resources with deterministic artifact names.
- Add the WorkON application icon, product metadata, and uninstall behavior.

Exit gate: install, first launch, upgrade, uninstall, and profile-data retention
are verified on a clean Windows VM.

## Release hardening

- Code signing and timestamping after certificates are available.
- Auto-update only after a release channel and rollback policy are defined.
- Crash reporting remains opt-in and must not include prompts, credentials, or
  session content by default.

## Current non-goals

- No second renderer implementation.
- No reuse of the agent-controlled Electron child process or window as trusted
  app chrome; only its isolated view/tab/PageAgent implementation is adapted.
- No installer, updater, signing, or `file://` IPC migration in Phase 1.
