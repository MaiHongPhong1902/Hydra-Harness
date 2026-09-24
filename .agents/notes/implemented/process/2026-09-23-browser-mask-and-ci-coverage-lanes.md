# Agent Note: Browser activity state stays owned by the preload controller

Status: implemented

## Problem

The embedded browser's activity indicator is owned by the preload mask, while the main process owns the count of in-flight browser calls. The preload also has to accept only the boolean activity state used by that IPC contract and apply the current state whenever its controller becomes available.

## Decision

The preload normalizes each activity IPC payload to a boolean, keeps the current state for controller startup, applies it after the initial mask is shown, and reapplies it on later activity events. The generated `preload.cjs` stays synchronized with the source entry.

Unit coverage retains the source scope and per-file 100% thresholds from `main`. Native Electron tests and assembled browser snapshots run in their owning gates; passing those suites does not replace instrumented unit coverage.

## Alternatives considered

**Read the raw IPC payload at each callback.** Rejected because the mask contract is boolean and a later controller startup must use the current normalized state.

**Lower the coverage threshold.** Rejected because every measured source file remains subject to the existing 100% gate.

## Consequences

The preload lifecycle test covers activity received before controller readiness and clearing after the document becomes interactive. Native keyboard tests wait for window and page focus before sending input. Electron correctness and assembled browser snapshots remain blocking gates alongside unit coverage.
