/** Package-owned invariant companion. @module @bosch/bh-plugin-runtime/invariant */

import type { Context } from '@bosch/cordis'
import type { InvariantInstaller } from '@bosch/bh-invariants'

const PACKAGE_NAME = '@bosch/bh-plugin-runtime'

/** Cordis companion plugin name. */
export const name = 'plugin-runtime-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: runtime lifecycle observations are covered by the package's focused tests. */
const install: InvariantInstaller = () => {}

/** Register the package ownership companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
