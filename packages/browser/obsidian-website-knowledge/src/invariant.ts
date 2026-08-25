/**
 * Package-owned invariant companion for `@bosch/bh-obsidian-website-knowledge`.
 * @module @bosch/bh-obsidian-website-knowledge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@bosch/cordis'
import type { InvariantInstaller } from '@bosch/bh-invariants'

const PACKAGE_NAME = '@bosch/bh-obsidian-website-knowledge'

/** Cordis companion plugin name. */
export const name = 'obsidian-website-knowledge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the graph is an external projection, and browser-result/settings tests own its checks. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
