/**
 * Package-owned invariant companion for `@hydraharness/harness-obsidian-knowledge`.
 * @module @hydraharness/harness-obsidian-knowledge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

const PACKAGE_NAME = '@hydraharness/harness-obsidian-knowledge'

/** Cordis companion plugin name. */
export const name = 'obsidian-knowledge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: vault contents are external state without an authoritative in-process event stream. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
