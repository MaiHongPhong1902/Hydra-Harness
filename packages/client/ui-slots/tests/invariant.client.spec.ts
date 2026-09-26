import { describe, expect, it } from 'vitest'
import { Context } from '@hydra1902/cordis'
import * as SlotsInvariant from '@hydra1902/harness-client-ui-slots/invariant'
import InvariantRegistry from '@hydra1902/harness-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SlotsInvariant).await()).resolves.toBeDefined()
  })
})
