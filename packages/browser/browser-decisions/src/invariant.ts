/** Package-owned invariant companion for `@hydra/harness-browser-decisions`. */

import type { InvariantInstaller } from '@hydra/harness-invariants'

const PACKAGE_NAME = '@hydra/harness-browser-decisions'
export const name = 'browser-decisions-invariant'
export const inject = ['invariants']
/** No runtime invariant: this consumer only registers an advisory tool. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: import('@hydra/cordis').Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
