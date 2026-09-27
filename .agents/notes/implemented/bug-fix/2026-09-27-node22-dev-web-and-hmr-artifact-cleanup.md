# Agent Note: Keep Node 22 web watch builds native and browser artifacts hermetic

Status: implemented

## Problem

Node 22.19's native TypeScript loader fails when `tsdown` composes its `import-without-cache` hook beneath the `tsx` process that launches `scripts/dev-web.ts`. Selecting `tsx` for every workspace config avoids that hook failure but makes the 50-package watch bootstrap too slow to reach the web watcher. The HMR browser test also rewrites the assembled Vite distribution while probing a source edit, so leaving that generated tree in place makes the next built-artifact consumer reject the client-build record.

## Decision

On Node 22, `scripts/dev-web.ts` re-enters itself once under Node's native strip-types loader before invoking `tsdown`; the child uses `configLoader: 'auto'`, while fixture-level calls that remain inside Vitest use `tsx`. The HMR test snapshots and restores `apps/web/dist` in addition to dynamic client bundles after stopping the watcher and host. Native Electron tests keep `show: false` so browser checks remain headless.

## Alternatives considered

**Use `configLoader: 'tsx'` for the full repository watch.** Rejected: it avoids the Node hook exception but stalled while loading the real workspace on Node 22, beyond the HMR readiness window.

**Keep `configLoader: 'auto'` inside the `tsx` parent.** Rejected: Node 22 reproducibly raises `ERR_INVALID_RETURN_PROPERTY_VALUE` from `import-without-cache` before workspace configs load.

**Restore only `lib/client.js` files.** Rejected: Vite rewrites `apps/web/dist`, which is part of the client-build digest and must be restored for later consumers.

## Consequences

Node 22 retains a usable web watch path without changing the Node 24 default loader behavior. The parent process forwards termination to the native child, and the HMR scenario leaves the built client artifact set unchanged. The initial Node 22 bootstrap remains slower than the Node 24 path because the complete client workspace performs its first builds locally.

## Testing

`pnpm exec vitest run scripts/dev-web.spec.ts --maxWorkers=1 --reporter=verbose` passes all three watcher tests. `HYDRA_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/hmr-live.e2e.ts --reporter=verbose` passes headlessly on Windows Node 22.19. `pnpm exec oxlint --config .oxlintrc.json apps/web/tests/hmr-live.e2e.ts packages/browser/browser-electron/tests/electron.spec.ts scripts/dev-web.ts` passes.
