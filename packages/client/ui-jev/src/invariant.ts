/** Package-owned invariant companion for `@hydra/harness-client-ui-jev`. */

import type { InvariantInstaller } from '@hydra/harness-invariants'

const PACKAGE_NAME = '@hydra/harness-client-ui-jev'
export const name = 'client-ui-jev-invariant'
export const inject = ['invariants']
/** No runtime invariant: this package only contributes a disposable UI slot. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: import('@hydra/cordis').Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
