/** Package-owned invariant companion for `@hydraharness/harness-llm-account-auth`. */

import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

const PACKAGE_NAME = '@hydraharness/harness-llm-account-auth'

/** Cordis companion plugin name. */
export const name = 'llm-account-auth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: account records and authorization events are owned by
 * the credentials and authorization seams; this plugin adds no independent
 * event relation to validate.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

