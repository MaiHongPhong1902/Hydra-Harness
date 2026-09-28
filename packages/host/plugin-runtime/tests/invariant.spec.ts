import { Context } from '@hydraharness/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@hydraharness/harness-invariants'
import * as PluginRuntimeInvariant from '../src/invariant.ts'

describe('plugin-runtime invariant companion', () => {
  it('registers the package-owned empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(PluginRuntimeInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.plugin(PluginRuntimeInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
