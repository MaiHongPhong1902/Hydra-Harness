/** Review presentation invariant ownership. @module */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'
/** Companion identity. */
export const name = 'client-ui-review-invariant'
/** Registration dependency. */
export const inject = ['invariants']
// No runtime invariant: review authority and hash validation belong to fs-review;
// this package only subscribes to committed data and registers disposable slots.
const install: InvariantInstaller = () => {}
/**
 * Register package ownership.
 * @param ctx - companion context.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydraharness/harness-client-ui-review', install))
