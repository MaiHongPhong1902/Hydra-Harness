import { describe, expect, it } from 'vitest'
import { Context } from '@bosch/cordis'
import * as PrimitivesInvariant from '@bosch/bh-client-ui-primitives/invariant'
import InvariantRegistry from '@bosch/bh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PrimitivesInvariant).await()).resolves.toBeDefined()
  })
})
