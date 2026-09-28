# Agent Note: `registerConfig`'s exact-path watcher could miss a rapid second change

Status: implemented

## Problem

`node 24 / snapshots and artifacts` failed `apps/cli/tests/built-bin.e2e.ts`'s custom-profile hot-reload case on real hosted CI, timing out waiting for the `ready` marker to reappear after the test's "removal reverts" step (writing `[]\n` back to a profile's `cordis.patch.yml` right after a prior generation-2 override had already gone through one successful reload cycle). Reproducing in a from-scratch Linux container (matching the hosted runner) confirmed this is a genuine, non-environmental flake: solo, unloaded runs of just this test failed ~30% of the time (6/20), including runs that took the full 20s timeout with no other process contention.

Temporary debug logging through the whole reload path (`vendor/hmr`'s `registerConfig`/`refreshConfig`, `packages/boot/app-boot`'s `watchUserPatches` refresh callback, `vendor/include`'s `internal/update` handler) captured a failing run's trace: the first write (generation 2) produced a matched `onChange` → `refreshConfig` → `entry.update` → `root.update` cycle that completed correctly and rewrote `ready`. The second write (`[]\n`) never produced a matched `onChange` event at all — raw `fs.watch`'s notification for that exact path was silently dropped, not merely delayed. The application logic downstream (patch composition, serialized applies, fresh `structuredClone` per apply) was never reached because the event never arrived.

## Decision

**Force `usePolling: true` (100ms interval) on `registerConfig`'s exact-path config watcher**, overriding whatever the host's HMR config otherwise requests for the main content watcher. This watcher covers a handful of config files at most (a profile's and the home-level `cordis.patch.yml`), so stat-polling's overhead is negligible, and it removes the dependency on OS-level inotify/fs.watch event delivery being reliable for a single exact path watched independently of the main recursive content watcher.

## Consequences

Validated in the same Linux container: 20/20 then 15/15 repeated runs of the previously-flaky test passed with the fix (versus 6/20 failures before), and the full `apps/cli/tests/built-bin.e2e.ts` suite (18/18) still passes, including the other hot-reload-touching cases (`reports a patch-overlay boot failure without hanging`, `keeps the app arguments across a user patch reload`). The main content watcher (module hot-reload, potentially many files) is untouched — only the exact-path config watcher changes.

## Alternatives considered

**Retrying the write from the test.** Rejected: the missed event is a real product-facing reliability gap (a user's second rapid config edit could just as well go unnoticed until their next edit), not a test-only artifact — fixing the watcher is the root cause, not the symptom.

**Debouncing or coalescing at the `onChange` layer.** Rejected: the event was never delivered at all, not delivered twice or out of order, so no amount of debounce/coalesce logic downstream of the raw `fs.watch` listener can recover it.

## Verification

Linux container (matching the hosted runner): 20/20 and 15/15 repeated runs of `built-bin.e2e.ts -t 'fully settles a custom profile'` passed post-fix (vs. ~30% failure pre-fix), and the full file's 18/18 tests pass. Local Windows run of the full file (pre-existing build, unaffected by the source-only change) shows the same pre-existing, unrelated single-test flake this session already characterized as Windows-local noise, confirmed non-reproducing on isolated retry.
