/**
 * The registry's invariant: after each reconciliation, the mounted bridge set
 * follows the stored records. The companion reads the authoritative projection
 * off the reconciliation event, so a violation is observable without
 * re-deriving it.
 */
import { Context } from '@hydra/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@hydra/harness-invariants'
import type { HookRecordSnapshot } from '@hydra/harness-hooks-registry/src/types.ts'
import * as HooksRegistryInvariant from '@hydra/harness-hooks-registry/src/invariant.ts'

/** One projection with the enablement and status a caller wants to test. */
function snapshot(enabled: boolean, status: HookRecordSnapshot['records'][number]['status']): HookRecordSnapshot {
  return {
    records: [{
      name: 'guardrails',
      dialect: 'claude-code',
      source: 'inline',
      enabled,
      status,
      events: ['Stop'],
      hookCount: 1,
    }],
  }
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(HooksRegistryInvariant)
  return ctx
}

describe('hooks-registry invariant companion', () => {
  it('accepts a reconciliation whose mounts match its records', async () => {
    const ctx = await harness()

    expect(() => { ctx.emit('hooks-registry/reconciled', snapshot(true, 'started')) }).not.toThrow()
    expect(() => { ctx.emit('hooks-registry/reconciled', snapshot(false, 'stopped')) }).not.toThrow()

    await ctx.fiber.dispose()
  })

  it('fails an enabled record with no live bridge', async () => {
    const ctx = await harness()

    expect(() => { ctx.emit('hooks-registry/reconciled', snapshot(true, 'stopped')) })
      .toThrow(/has no live bridge after reconciliation/u)

    await ctx.fiber.dispose()
  })

  it('fails a disabled record that still reports a mount', async () => {
    const ctx = await harness()

    expect(() => { ctx.emit('hooks-registry/reconciled', snapshot(false, 'started')) })
      .toThrow(/still reports started/u)

    await ctx.fiber.dispose()
  })

  it('re-registers after its fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(HooksRegistryInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()

    await expect(ctx.plugin(HooksRegistryInvariant).await()).resolves.toBeDefined()

    await ctx.fiber.dispose()
  })
})
