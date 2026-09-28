/**
 * Package-owned invariant companion for `@hydraharness/harness-client-ui-settings-personalization`.
 * @module @hydraharness/harness-client-ui-settings-personalization/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

const PACKAGE_NAME = '@hydraharness/harness-client-ui-settings-personalization'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-personalization-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a settings.section registrant owns no cross-plugin
 * event stream or mutable relation; slot conflicts fail loud in the slot
 * core, and the custom-instructions revision/conflict path is covered by
 * this package's own store tests.
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
