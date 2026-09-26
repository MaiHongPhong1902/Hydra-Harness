/**
 * Package-owned invariant companion for `@hydra1902/harness-command-goal`.
 * @module @hydra1902/harness-command-goal/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@hydra1902/cordis'
import type { InvariantInstaller } from '@hydra1902/harness-invariants'

const PACKAGE_NAME = '@hydra1902/harness-command-goal'

/** Cordis companion plugin name. */
export const name = 'command-goal-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this command adapter owns no event stream or state projection; accepted
 * mutations are checked by the goal domain and command dispatch behavior is covered by package tests.
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
