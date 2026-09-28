import { describe, expect, it } from 'vitest'
import { Context } from '@hydraharness/cordis'
import * as SidebarInvariant from '@hydraharness/harness-client-ui-sidebar/invariant'
import InvariantRegistry from '@hydraharness/harness-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SidebarInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply is a no-op host placeholder', async () => {
    const { apply } = await import('@hydraharness/harness-client-ui-sidebar')
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
