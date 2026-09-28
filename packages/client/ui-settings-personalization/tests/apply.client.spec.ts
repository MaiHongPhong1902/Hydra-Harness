/**
 * Registration: the Personalization settings section defers until
 * `settings.section` has been declared, and its injected face routes custom
 * instructions and personality actions to their own transports.
 */

import { Context } from '@hydraharness/cordis'
import type { ConnectionHandle } from '@hydraharness/harness-api-remotes/client'
import { describe, expect, it, vi } from 'vitest'
import z from '@hydraharness/schemastery'
import { resolveSlotLabel } from '@hydraharness/harness-client-ui-slots'
import { SlotRegistry } from '@hydraharness/harness-client-runtime/client'
import { LocaleRuntime } from '@hydraharness/harness-client-locale/client'
import { TestRemote } from '@hydraharness/harness-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@hydraharness/harness-client-ui-settings/client'
import { apply, inject } from '@hydraharness/harness-client-ui-settings-personalization/client'
import { PersonalizationSection } from '../src/client/PersonalizationSection.tsx'
import type { PersonalizationSectionInjected } from '../src/client/PersonalizationSection.tsx'

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** A minimal real schemastery schema, standing in for the Host's serialized personalization namespace schema. */
const PERSONALITY_SCHEMA = z.object({
  personality: z.union(['friendly', 'pragmatic', 'none']).default('pragmatic'),
}).toJSON()
const MEMORY_SCHEMA = z.object({
  enabled: z.boolean().default(false), useMemories: z.boolean().default(true), generateMemories: z.boolean().default(true),
}).toJSON()

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  new TestRemote(ctx)
  let personalityDoc: Record<string, unknown> = {}
  let memoryDoc: Record<string, unknown> = {}
  let instructionsDoc = { content: '', revision: EMPTY_SHA256 }
  const calls: string[] = []
  ctx.provide('connection', {
    api: {
      settings: {
        describe: () => Promise.resolve({
          rpcId: 'r',
          result: {
            ok: true as const,
            value: {
              writable: true,
              hasDocument: false,
              namespaces: [{
                ns: 'personalization',
                schema: PERSONALITY_SCHEMA,
                value: { personality: 'pragmatic', ...personalityDoc },
                applies: 'live' as const,
                secrets: [],
                revision: 0,
              }, {
                ns: 'memory',
                schema: MEMORY_SCHEMA,
                value: { enabled: false, useMemories: true, generateMemories: true, ...memoryDoc },
                applies: 'live' as const,
                secrets: [],
                revision: 0,
              }],
            },
          },
        }),
        mutate: (payload: { ns: string; ops: { op: string; path: string[]; value?: unknown }[] }) => {
          calls.push(`mutate:${JSON.stringify(payload.ops)}`)
          for (const op of payload.ops) {
            if (op.op === 'set') {
              if (payload.ns === 'memory') memoryDoc = { ...memoryDoc, [op.path[0]!]: op.value }
              else personalityDoc = { ...personalityDoc, [op.path[0]!]: op.value }
            }
          }
          return Promise.resolve({
            rpcId: 'r',
            result: {
              ok: true as const,
              value: {
                ns: payload.ns,
                schema: payload.ns === 'memory' ? MEMORY_SCHEMA : PERSONALITY_SCHEMA,
                value: payload.ns === 'memory'
                  ? { enabled: false, useMemories: true, generateMemories: true, ...memoryDoc }
                  : { personality: 'pragmatic', ...personalityDoc },
                applies: 'live' as const,
                secrets: [],
                revision: 1,
              },
            },
          })
        },
        readInstructions: () => {
          calls.push('readInstructions')
          return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: instructionsDoc } })
        },
        writeInstructions: (payload: { content: string }) => {
          calls.push(`writeInstructions:${payload.content}`)
          instructionsDoc = { content: payload.content, revision: 'b'.repeat(64) }
          return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: instructionsDoc } })
        },
        listMemories: () => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { entries: [] } } }),
        removeMemory: () => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { removed: true } } }),
      },
    },
    isLoopback: true,
  } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, calls }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-personalization apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'settingsScope'])
  })

  it('registers the Personalization section at order 1', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    expect(section.component).toBe(PersonalizationSection)
    expect(section.options).toMatchObject({ id: 'personalization', order: 1 })
    expect(resolveSlotLabel(section.options.label)).toBe('Personalization')
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()

    await ctx.plugin({ inject: [...inject], apply }).await()
    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('routes custom-instructions load and save through the RPC pair', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => PersonalizationSectionInjected)()

    await section.load()
    section.setDraft('be concise')
    await section.save()

    expect(calls).toContain('readInstructions')
    expect(calls).toContain('writeInstructions:be concise')
    expect(section.hooks.instructions.getSnapshot()).toMatchObject({ status: 'ready', savedContent: 'be concise' })
    section.setDraft('unsaved')
    await section.reload()
    expect(section.hooks.instructions.getSnapshot().draft).toBe('be concise')
  })

  it('routes a personality change through the settings-mutate transport', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => PersonalizationSectionInjected)()
    await vi.waitFor(() => { expect(section.hooks.personality.getSnapshot().status).toBe('ready') })

    section.setPersonality('friendly')
    expect(calls).toEqual([])
    expect(section.hooks.personalityDraft.getSnapshot().value).toBe('friendly')
    await section.savePersonality()

    expect(calls).toEqual([
      `mutate:${JSON.stringify([{ op: 'set', path: ['personality'], value: 'friendly' }])}`,
    ])
    expect(section.hooks.personality.getSnapshot().value).toEqual({ personality: 'friendly' })
    expect(section.hooks.personalityDraft.getSnapshot()).toEqual({ value: undefined, saving: false, failed: false })
  })

  it('routes a memory toggle and the management RPCs', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => PersonalizationSectionInjected)()
    await vi.waitFor(() => { expect(section.hooks.memory.getSnapshot().status).toBe('ready') })

    await section.setMemory('enabled', true)
    expect(await section.loadMemories()).toEqual([])
    expect(await section.removeMemory('00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(calls).toContain(`mutate:${JSON.stringify([{ op: 'set', path: ['enabled'], value: true }])}`)
  })

  it('retains a newer tone draft during Save and across section reinjection', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const sectionFactory = slots.entries('settings.section')[0]!.inject as unknown as () => PersonalizationSectionInjected
    const section = sectionFactory()
    await vi.waitFor(() => { expect(section.hooks.personality.getSnapshot().status).toBe('ready') })
    const api = (ctx.get('connection') as ConnectionHandle).api.settings
    const original = api.mutate.bind(api)
    const pending = Promise.withResolvers<undefined>()
    const write = vi.spyOn(api, 'mutate').mockImplementation(async (payload) => {
      await pending.promise
      return original(payload)
    })
    section.setPersonality('friendly')
    const saving = section.savePersonality()
    section.setPersonality('none')
    await section.savePersonality()
    pending.resolve(undefined)
    await saving
    expect(write).toHaveBeenCalledOnce()
    expect(sectionFactory().hooks.personalityDraft.getSnapshot()).toEqual({ value: 'none', saving: false, failed: false })
    await section.savePersonality()
    expect(section.hooks.personality.getSnapshot().value?.personality).toBe('none')
    await ctx.fiber.dispose()
  })

  it('keeps a rejected tone draft available for retry', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => PersonalizationSectionInjected)()
    await vi.waitFor(() => { expect(section.hooks.personality.getSnapshot().status).toBe('ready') })
    const api = (ctx.get('connection') as ConnectionHandle).api.settings
    vi.spyOn(api, 'mutate').mockRejectedValueOnce(new Error('Disconnected'))
    section.setPersonality('friendly')
    await section.savePersonality()
    expect(section.hooks.personalityDraft.getSnapshot()).toEqual({ value: 'friendly', saving: false, failed: true })
    await section.savePersonality()
    expect(section.hooks.personalityDraft.getSnapshot()).toEqual({ value: undefined, saving: false, failed: false })
    await ctx.fiber.dispose()
  })

  it.each(['resolve', 'reject', 'reject-after-dispose'] as const)('handles a pending tone write: %s', async (outcome) => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => PersonalizationSectionInjected)()
    await vi.waitFor(() => { expect(section.hooks.personality.getSnapshot().status).toBe('ready') })
    const pending = Promise.withResolvers<undefined>()
    vi.spyOn(section.hooks.personality, 'set').mockReturnValueOnce(pending.promise)
    section.setPersonality('friendly')
    const saving = section.savePersonality()
    if (outcome !== 'reject') await ctx.fiber.dispose()
    if (outcome === 'resolve') pending.resolve(undefined)
    else pending.reject(new Error('write failed'))
    await saving
    expect(section.hooks.personalityDraft.getSnapshot().failed).toBe(outcome === 'reject')
    if (outcome === 'reject') await ctx.fiber.dispose()
  })

  it('propagates memory RPC business errors to the section', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => PersonalizationSectionInjected)()
    const api = (ctx.get('connection') as ConnectionHandle).api.settings
    const failure = { rpcId: 'r' as never, result: { ok: false as const, error: { code: 'internal' as const, message: 'memory unavailable', details: {} } } }
    vi.spyOn(api, 'listMemories').mockResolvedValueOnce(failure)
    vi.spyOn(api, 'removeMemory').mockResolvedValueOnce(failure)
    await expect(section.loadMemories()).rejects.toThrow('memory unavailable')
    await expect(section.removeMemory('missing')).rejects.toThrow('memory unavailable')
    await ctx.fiber.dispose()
  })
})
