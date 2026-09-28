import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import * as Jev from '@hydraharness/harness-jev'
import type { ToolDefinition } from '@hydraharness/harness-tools'
import { apply } from '../src/index.ts'

let context: Context | undefined

const args = { state: 'button', question: 'next', choices: ['click', 'stop'] }
const execution = { callId: 'test', signal: new AbortController().signal }

async function mount(systemOne?: Jev.JevService['systemOne']): Promise<ToolDefinition> {
  context = new Context()
  let tool: ToolDefinition | undefined
  context.reflect.provide('tools', { register: (definition: ToolDefinition) => {
    tool = definition
    return () => {}
  } })
  if (systemOne !== undefined) context.reflect.provide('jev', { systemOne })
  await context.plugin({ inject: ['tools'], apply }).await()
  return tool!
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('browser decisions', () => {
  it('forwards candidate labels and cancellation, and renders the selected action', async () => {
    const systemOne = vi.fn<Jev.JevService['systemOne']>().mockResolvedValue({
      model: 'jev', answers: { decision: { type: 'choice', choice: 'click', confidence: 0.925 } },
    })
    const tool = await mount(systemOne)
    const result = await tool.execute(args, execution as never)
    expect(systemOne).toHaveBeenCalledWith({ state: 'button', questions: {
      decision: { type: 'choice', instructions: 'next', criteria: { click: 'click', stop: 'stop' } },
    } }, { signal: execution.signal })
    expect(result).toEqual({ available: true, decision: 'click', confidence: 0.925 })
    expect(tool.output.render(args, result as never)).toEqual([{ type: 'text', text: 'Jev chose click (93% confidence).' }])
    expect(tool.presentCall?.(args)).toEqual({ card: 'generic', title: 'Ask Jev for a browser decision', kind: 'other' })
    expect(tool.output.render(args, { available: true })).toEqual([{ type: 'text', text: 'Jev chose no action.' }])
    expect(tool.output.render(args, { available: false })).toEqual([{ type: 'text', text: 'Jev decision unavailable: provider not configured' }])
    expect(tool.output.render(args, { available: false, reason: 'offline' })).toEqual([{ type: 'text', text: 'Jev decision unavailable: offline' }])
  })

  it.each([
    { ...args, state: ' ' }, { ...args, question: ' ' },
    { ...args, choices: ['click', ' '] }, { ...args, choices: ['click'] },
    { ...args, choices: ['click', 'click'] },
  ])('rejects unusable candidate input before calling Jev: %j', async (input) => {
    const systemOne = vi.fn<Jev.JevService['systemOne']>()
    const tool = await mount(systemOne)
    await expect(tool.execute(input, execution as never)).resolves.toEqual({
      available: false, reason: 'Provide at least two distinct candidate choices.',
    })
    expect(systemOne).not.toHaveBeenCalled()
  })

  it.each<Jev.JevAnswer | undefined>([
    undefined, { type: 'noul', noul: 1 }, { type: 'choice', choice: 1 },
    { type: 'choice', choice: 'other' }, { type: 'choice', choice: 'click' },
    ...[NaN, -0.1, 1.1].map(confidence => ({ type: 'choice' as const, choice: 'click', confidence })),
  ])('abstains when the decision does not identify a candidate with a probability: %j', async (answer) => {
    const tool = await mount(async () => ({ model: 'jev', answers: answer === undefined ? {} : { decision: answer } }))
    await expect(tool.execute(args, execution as never)).resolves.toEqual({
      available: false, reason: 'Jev returned no candidate choice.',
    })
  })

  it.each([
    [new Jev.JevError('secret upstream message', 'AUTH'), 'Jev unavailable (AUTH). Continue with the existing browser tools.'],
    [new Error('secret upstream message'), 'Jev request failed. Continue with the existing browser tools.'],
  ] as const)('contains provider failures without exposing upstream text', async (error, reason) => {
    const tool = await mount(async () => { throw error })
    await expect(tool.execute(args, execution as never)).resolves.toEqual({ available: false, reason })
  })

  it('returns an abstention when the optional Jev service is absent', async () => {
    context = new Context()
    let registered: import('@hydraharness/harness-tools').ToolDefinition | undefined
    context.reflect.provide('tools', { register: (definition: import('@hydraharness/harness-tools').ToolDefinition) => {
      registered = definition
      return () => {}
    } })
    await context.plugin({ inject: ['tools'], apply }).await()
    const tool = registered!
    const result = await tool.execute({ state: 'button', question: 'next', choices: ['click', 'stop'] }, {
      callId: 'test', signal: new AbortController().signal,
    } as never)
    expect(result).toMatchObject({ available: false })
  })

  it('keeps the tool path available when Jev is mounted without a credential', async () => {
    context = new Context()
    let registered: import('@hydraharness/harness-tools').ToolDefinition | undefined
    context.reflect.provide('tools', { register: (definition: import('@hydraharness/harness-tools').ToolDefinition) => {
      registered = definition
      return () => {}
    } })
    await context.plugin(Jev, { apiKeyEnv: '__HYDRA_TEST_TYPESAFE_KEY_MISSING__' }).await()
    await context.plugin({ inject: ['tools'], apply }).await()
    const result = await registered!.execute({ state: 'button', question: 'next', choices: ['click', 'stop'] }, {
      callId: 'test', signal: new AbortController().signal,
    } as never)
    expect(result).toMatchObject({ available: false })
  })
})
