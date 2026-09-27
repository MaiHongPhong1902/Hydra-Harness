/**
 * Package-owned invariant companion for `@hydra1902/harness-tool-bash`.
 * @module @hydra1902/harness-tool-bash/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@hydra1902/cordis'
import type { InvariantInstaller } from '@hydra1902/harness-invariants'

const PACKAGE_NAME = '@hydra1902/harness-tool-bash'

/** Cordis companion plugin name. */
export const name = 'tool-bash-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the environment registry validates ownership and collected values at each
 * mutation/read; it publishes no independent snapshot that a companion could cross-check.
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
