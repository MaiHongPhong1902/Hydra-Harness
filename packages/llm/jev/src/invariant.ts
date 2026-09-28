/** Package-owned invariant companion for `@hydraharness/harness-jev`. */

import type { InvariantInstaller } from '@hydraharness/harness-invariants'

const PACKAGE_NAME = '@hydraharness/harness-jev'

/** Cordis companion plugin name. */
export const name = 'jev-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the provider owns one request/response operation. */
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: import('@hydraharness/cordis').Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
