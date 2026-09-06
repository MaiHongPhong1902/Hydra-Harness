/**
 * Package-owned invariant companion for `@hydra/harness-hooks-registry`.
 * @module @hydra/harness-hooks-registry/invariant
 */

import type { Context } from '@hydra/cordis'
import type { InvariantFailure, InvariantInstaller } from '@hydra/harness-invariants'
import type { HookRecordSnapshot } from './types.ts'

const PACKAGE_NAME = '@hydra/harness-hooks-registry'

/** Cordis companion plugin name. */
export const name = 'hooks-registry-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * The registry's contract is that the mounted bridge set follows the stored
 * records once reconciliation settles: an enabled record it accepted is live,
 * and a disabled one is not. Both sides ride the reconciliation event, so the
 * check observes the authoritative projection rather than re-deriving it.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('hooks-registry/reconciled', (snapshot: HookRecordSnapshot) => {
    for (const record of snapshot.records) {
      if (record.enabled && record.status === 'stopped') {
        fail(`enabled hook record ${JSON.stringify(record.name)} has no live bridge after reconciliation`)
      }
      if (!record.enabled && record.status !== 'stopped') {
        fail(`disabled hook record ${JSON.stringify(record.name)} still reports ${record.status}`)
      }
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
