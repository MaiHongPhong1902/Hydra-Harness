/** Research charge records must preserve their accounting units. */
import type { Context } from '@hydra1902/cordis'
import type { InvariantInstaller } from '@hydra1902/harness-invariants'
import type {} from './index.ts'

export const name = 'research-policy-invariant'
export const inject = ['invariants']

const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'research/charge') return
    if (!Number.isSafeInteger(event.data.queries) || event.data.queries < 0
      || (event.data.kind !== 'search' && event.data.queries !== 0)) fail('research charge has invalid query units')
  })
}

/**
 * Register the charge invariant.
 * @param ctx - context carrying invariant registrations.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@hydra1902/harness-research-policy', install))
