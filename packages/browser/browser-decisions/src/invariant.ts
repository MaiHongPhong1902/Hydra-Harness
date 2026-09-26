/** Package-owned invariant companion for `@hydra1902/harness-browser-decisions`. */

import type { InvariantInstaller } from '@hydra1902/harness-invariants'

const PACKAGE_NAME = '@hydra1902/harness-browser-decisions'
export const name = 'browser-decisions-invariant'
export const inject = ['invariants']
/** No runtime invariant: this consumer only registers an advisory tool. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: import('@hydra1902/cordis').Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
