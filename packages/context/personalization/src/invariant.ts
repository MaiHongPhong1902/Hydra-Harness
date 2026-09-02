/**
 * Package-owned invariant companion for `@bosch/bh-personalization`.
 * @module @bosch/bh-personalization/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@bosch/cordis'
import type { InvariantInstaller } from '@bosch/bh-invariants'

const PACKAGE_NAME = '@bosch/bh-personalization'

/** Cordis companion plugin name. */
export const name = 'personalization-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is the sole writer and reader of both
 * its settings namespace and every `personalization/personality` event, so
 * there is no cross-plugin relationship for a companion to verify.
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
