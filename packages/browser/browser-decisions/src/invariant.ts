/** Package-owned invariant companion for `@hydraharness/harness-browser-decisions`. */

import type { InvariantInstaller } from '@hydraharness/harness-invariants'

const PACKAGE_NAME = '@hydraharness/harness-browser-decisions'
export const name = 'browser-decisions-invariant'
export const inject = ['invariants']
/** No runtime invariant: this consumer only registers an advisory tool. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: import('@hydraharness/cordis').Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
