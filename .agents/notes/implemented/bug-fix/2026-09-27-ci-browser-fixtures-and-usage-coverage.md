# Agent Note: Keep browser fixtures and per-file usage coverage aligned

Status: implemented

## Problem

The assembled browser tool schema changed while the ACP header sidecar for `browser-tool-turn` and `browser-selective-turn` stayed on the older click and screenshot fields. A Web E2E golden also stored the host's native preset path separator. The strict per-file 100% coverage gate then exposed untested provider-usage parsing and transport branches even though the surrounding behavior tests passed.

## Decision

Refresh the shared keyless browser schema sidecar from the assembled tool registry whenever the browser contract changes, so coordinate clicks and screenshot `clip`/`full_page` fields are recorded with their current descriptions. Normalize the rendered preset path to `/` at the snapshot comparison boundary; production paths remain native. Cover provider usage validation, fallback, cancellation, and optional response fields through the owning account tests while retaining the 100% per-file threshold. The [browser snapshot gate](../testing/2026-07-30-web-browser-snapshot-ci-gate.md), [cross-platform fixture guidance](../testing/2026-07-22-cross-platform-test-fixtures.md), and [partitioned coverage gate](../process/2026-08-18-in-job-partitioned-coverage.md) remain the governing CI mechanisms.

## Alternatives considered

**Refresh only the selective browser fixture** was rejected because both scenarios consume the shared browser tool header schema.

**Normalize separators in production output** was rejected because the application must preserve native filesystem paths; only the platform-neutral golden needs stable spelling.

**Lower the coverage threshold or ignore the usage module** was rejected because it would hide provider response and cancellation paths that the account contract owns.

## Consequences

Keyless browser replay now checks the current schema, and the preset golden is portable across Windows and POSIX hosts. Account-usage tests exercise every measured parser and transport branch, so the merged coverage report can enforce 100% per-file coverage without weakening the repository gate. The workflow aggregate remains unchanged; its Windows native lane continues to be observational as specified by the existing CI inventory.
