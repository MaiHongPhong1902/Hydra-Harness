# Agent Note: Desktop browser connection preemption and host utility process launch

Status: implemented

## Problem

In multi-turn or multi-agent desktop sessions, when an agent initialized or reconnected to the embedded browser bridge while a previous connection handle was still held (e.g. from an earlier turn, aborted session, or background agent), `apps/desktop/main.cjs` rejected the incoming connection with `another agent already owns the desktop browser`. This caused browser tools (`browser_state`, `browser_navigate`) to fail immediately with an unrecoverable bridge error.

Additionally, launching the desktop application via `npm run desktop` failed on Windows with `electron.exe: bad option: --type=utility` because `startHost()` spawned the host process using Electron's `utilityProcess.fork()` while `ELECTRON_RUN_AS_NODE: '1'` was set in the environment. Setting `ELECTRON_RUN_AS_NODE: '1'` forces Electron into pure Node CLI mode, which cannot parse internal Chromium utility process arguments (`--type=utility`, `--utility-sub-type=...`).

## Decision

1. **Preemptive Browser Connection Handover**:
   - In `apps/desktop/main.cjs`, `handleBrowserMessage` now cancels pending permissions on the active browser controller (`browser?.cancelPermissions()`), notifies the previous connection to close (`postBrowser(browserConnection, 'hydra-browser-close')`), resets `browserConnection = undefined`, and accepts the new connection ID.
   - When an agent or session initiates a connection, it cleanly preempts the prior connection without rejecting or requiring a manual desktop restart.
   - Updated `packages/browser/browser-electron/tests/child.spec.ts` to test desktop bridge preemption cleanly, verifying that the previous connection's `closed` promise resolves and the incoming connection takes ownership.

2. **Clean `utilityProcess` Environment**:
   - In `apps/desktop/main.cjs` `startHost()`, explicitly scrub `ELECTRON_RUN_AS_NODE` from `hostEnv` (`delete hostEnv.ELECTRON_RUN_AS_NODE`) before calling `utilityProcess.fork()`.
   - This ensures Electron's utility process launches normally as a Chromium helper process rather than choking on internal Chromium CLI flags.

## Alternatives considered

**Rejecting with lock retry**: Having the client poll or wait for the prior session to disconnect. Rejected because aborted or background turns may never send an explicit disconnect message, permanently wedging the embedded desktop browser.

**Multi-window or multi-browser instances**: Spawning separate browser view instances for each connection. Rejected because the desktop app has a single shared right-side browser panel that represents the user's visible browser viewport.

## Consequences

- New agent turns and reconnected sessions can seamlessly use the desktop browser without collision errors.
- Previous connections are cleanly notified of disconnection (`hydra-browser-close`) and their permissions cancelled.
- Desktop startup via `npm run desktop` cleanly forks the host utility process across all platforms without `ELECTRON_RUN_AS_NODE` corruption.

## Testing

- Unit test in `packages/browser/browser-electron/tests/child.spec.ts`: `preempts earlier desktop browser connection when another agent connects` passes.
- All 92 browser-electron tests pass cleanly (`pnpm test packages/browser/browser-electron`).
- Desktop smoke suite passes cleanly (`pnpm --filter @hydra/harness-desktop run smoke`).
