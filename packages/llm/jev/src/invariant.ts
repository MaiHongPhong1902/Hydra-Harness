/** Package-owned invariant companion for `@hydra/harness-jev`. */

import type { InvariantInstaller } from '@hydra/harness-invariants'

const PACKAGE_NAME = '@hydra/harness-jev'

/** Cordis companion plugin name. */
export const name = 'jev-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the provider owns one request/response operation. */
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: import('@hydra/cordis').Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
