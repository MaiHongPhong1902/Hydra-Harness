/** Review storage validates ownership and hashes at its durable parser. @module */
import type { Context } from '@hydraharness/cordis'
import type { InvariantInstaller } from '@hydraharness/harness-invariants'

/** Companion plugin identity. */
export const name = 'fs-review-invariant'
/** Registration owner. */
export const inject = ['invariants']

// No runtime invariant: snapshot integrity relates persisted raw bytes to metadata;
// the async read/restore boundary verifies it before any workspace mutation.
const install: InvariantInstaller = () => {}

/**
 * Register the package's invariant ownership.
 * @param ctx - companion context.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydraharness/harness-fs-review', install))
