/** Package ownership for verified page guidance. @module @hydraharness/harness-page-memory/invariant */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

/** Cordis companion plugin name. */
export const name = 'page-memory-invariant'
/** Registry that owns invariant installations. */
export const inject = ['invariants']

/** No runtime invariant: page identity, DOM checks, and stored files are external state; tools validate them at each use. */
const install: InvariantInstaller = () => {}

/** Register the package companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydraharness/harness-page-memory', install))
