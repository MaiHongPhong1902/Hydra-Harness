/**
 * Package-owned invariant companion for `@bosch/bh-file-reference-local`.
 * @module @bosch/bh-file-reference-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@bosch/cordis'
import type { InvariantInstaller } from '@bosch/bh-invariants'

const PACKAGE_NAME = '@bosch/bh-file-reference-local'

/** Cordis companion plugin name. */
export const name = 'file-reference-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: per-agent indexes are private advisory caches whose
 * invalidation and disposal are observed directly through service tests.
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
