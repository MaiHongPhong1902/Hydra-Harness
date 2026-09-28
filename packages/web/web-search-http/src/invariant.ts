/**
 * Package-owned invariant companion for `@hydraharness/harness-web-search-http`.
 * @module @hydraharness/harness-web-search-http/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

const PACKAGE_NAME = '@hydraharness/harness-web-search-http'

/** Cordis companion plugin name. */
export const name = 'web-search-http-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: request mapping has no independent mutable state; provider registration ownership is checked by the web service.
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
