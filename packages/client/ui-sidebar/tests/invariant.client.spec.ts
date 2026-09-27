import { describe, expect, it } from 'vitest'
import { Context } from '@hydra1902/cordis'
import * as SidebarInvariant from '@hydra1902/harness-client-ui-sidebar/invariant'
import InvariantRegistry from '@hydra1902/harness-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SidebarInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply is a no-op host placeholder', async () => {
    const { apply } = await import('@hydra1902/harness-client-ui-sidebar')
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
