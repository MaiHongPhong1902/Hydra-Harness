/**
 * Package-owned invariant companion for `@bosch/bh-browser-electron`.
 * @module @bosch/bh-browser-electron/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@bosch/cordis'
import type { InvariantInstaller } from '@bosch/bh-invariants'

const PACKAGE_NAME = '@bosch/bh-browser-electron'

/** Cordis companion plugin name. */
export const name = 'browser-electron-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the owner-scoped child registry is private mutable
 * state, and the service exposes neither a lifecycle stream nor an unscoped
 * snapshot to check against.
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
