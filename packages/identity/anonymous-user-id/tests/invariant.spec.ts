import { describe, expect, it } from 'vitest'
import { Context } from '@hydra1902/cordis'
import InvariantRegistry from '@hydra1902/harness-invariants'
import * as UserIdInvariant from '@hydra1902/harness-anonymous-user-id/invariant'

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(UserIdInvariant).await()).resolves.toBeDefined()
  })
})
