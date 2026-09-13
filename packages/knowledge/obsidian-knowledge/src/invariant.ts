/**
 * Package-owned invariant companion for `@hydra/harness-obsidian-knowledge`.
 * @module @hydra/harness-obsidian-knowledge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@hydra/cordis'
import type { InvariantInstaller } from '@hydra/harness-invariants'

const PACKAGE_NAME = '@hydra/harness-obsidian-knowledge'

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
