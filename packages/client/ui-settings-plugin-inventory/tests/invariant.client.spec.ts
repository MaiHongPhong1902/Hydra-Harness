import { Context } from '@hydra1902/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@hydra1902/harness-invariants'
import * as PluginsInvariant from '../src/invariant.ts'

describe('ui-settings-plugin-inventory invariant companion', () => {
  it('registers the empty installer and keeps the node half inert', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PluginsInvariant).await()).resolves.toBeDefined()
    const { apply } = await import('../src/index.ts')
    apply()
    await ctx.fiber.dispose()
  })
})
