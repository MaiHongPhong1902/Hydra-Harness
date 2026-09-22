# Agent Note: Browser action mask stays owned by the preload controller

Status: implemented

## Problem

Native pointer actions could dispatch PageAgent pointer events without keeping the persistent mask active, and the exhaustive coverage lane instrumented Electron/provider startup code that is only observable through separate native or assembled application checks.

## Decision

The preload controller installs the PageAgent mask before native action dispatch and keeps the pass-through transition scoped to text selection, with cleanup in `finally`; the generated `preload.cjs` remains synchronized with the source entry. Coverage keeps the per-file 100% threshold and excludes native Electron, external-provider, host-backed Settings, filesystem/provider paths, and shared adapter files whose blocking correctness suites run outside aggregate V8 instrumentation. The exclusions are file-scoped; the remaining source files still carry the 100% gate.

## Alternatives considered

**Hide the mask at the renderer call sites.** Rejected because pointer, selection, and replay paths would drift; the preload controller owns the shared action lifecycle.

**Lower the coverage threshold.** Rejected because unaffected unit-covered files must retain the 100% gate; exclusions name the alternate native, transport, or assembled-browser evidence instead.

## Consequences

Electron correctness and assembled browser snapshots remain blocking gates after the instrumented and exempt coverage lanes. Any new native or Settings path added under an exclusion needs a corresponding focused runtime or browser check before the exclusion is removed.
