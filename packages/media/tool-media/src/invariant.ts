/**
 * Package-owned invariant companion for `@hydraharness/harness-tool-media`.
 * @module @hydraharness/harness-tool-media/invariant
 */

import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

const PACKAGE_NAME = '@hydraharness/harness-tool-media'

/** Cordis companion plugin name. */
export const name = 'tool-media-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tool owns no event stream; the tool registry owns
 * settlement and the attachment service owns durable image and video objects.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
