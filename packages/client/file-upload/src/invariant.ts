/**
 * Package-owned invariant companion for `@hydra/harness-client-file-upload`.
 * @module @hydra/harness-client-file-upload/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@hydra/cordis'
import type { InvariantInstaller } from '@hydra/harness-invariants'

const PACKAGE_NAME = '@hydra/harness-client-file-upload'

/** Cordis companion plugin name. */
export const name = 'client-file-upload-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package contributes only effect-owned slot entries;
 * the slot registry owns their lifecycle and validates their declarations.
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
