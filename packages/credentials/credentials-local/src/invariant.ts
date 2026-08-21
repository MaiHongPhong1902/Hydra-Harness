/**
 * Package-owned invariant companion for `@bosch/bh-credentials-local`.
 * @module @bosch/bh-credentials-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@bosch/cordis'
import type { InvariantInstaller } from '@bosch/bh-invariants'

const PACKAGE_NAME = '@bosch/bh-credentials-local'

/** Cordis companion plugin name. */
export const name = 'credentials-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the Service Definition companion (`bh-credentials/invariant`) owns the
 * `credentials/reference-updated` lifecycle contract; this provider's file/environment layering is
 * asynchronous I/O pinned by its unit suite.
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
