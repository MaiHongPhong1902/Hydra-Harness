import { describe, expect, it } from 'vitest'
import { Context } from '@hydra1902/cordis'
import * as TestRuntimeInvariant from '@hydra1902/harness-client-test-runtime/invariant'
import InvariantRegistry from '@hydra1902/harness-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(TestRuntimeInvariant).await()).resolves.toBeDefined()
  })
})
