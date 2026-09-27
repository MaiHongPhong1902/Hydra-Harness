/** Package-owned invariant companion for `@hydra1902/harness-client-ui-jev`. */

import type { InvariantInstaller } from '@hydra1902/harness-invariants'

const PACKAGE_NAME = '@hydra1902/harness-client-ui-jev'
export const name = 'client-ui-jev-invariant'
export const inject = ['invariants']
/** No runtime invariant: this package only contributes a disposable UI slot. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: import('@hydra1902/cordis').Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
