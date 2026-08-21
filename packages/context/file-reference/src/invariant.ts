/**
 * Package-owned invariant companion for `@bosch/bh-file-reference`.
 * @module @bosch/bh-file-reference/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@bosch/cordis'
import type { InvariantInstaller } from '@bosch/bh-invariants'

const PACKAGE_NAME = '@bosch/bh-file-reference'

/** Cordis companion plugin name. */
export const name = 'file-reference-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the interface retains no candidate or lifecycle
 * state; concrete providers own their cache and invalidation relationships.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
