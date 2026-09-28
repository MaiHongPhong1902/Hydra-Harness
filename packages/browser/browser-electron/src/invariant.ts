/**
 * Package-owned invariant companion for `@hydraharness/harness-browser-electron`.
 * @module @hydraharness/harness-browser-electron/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

const PACKAGE_NAME = '@hydraharness/harness-browser-electron'

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
