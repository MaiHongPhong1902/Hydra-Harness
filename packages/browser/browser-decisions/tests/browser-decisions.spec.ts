import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@hydra/cordis'
import * as Jev from '@hydra/harness-jev'
import { apply } from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('browser decisions', () => {
  it('returns an abstention when the optional Jev service is absent', async () => {
    context = new Context()
    let registered: import('@hydra/harness-tools').ToolDefinition | undefined
    context.reflect.provide('tools', { register: (definition: import('@hydra/harness-tools').ToolDefinition) => {
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
    let registered: import('@hydra/harness-tools').ToolDefinition | undefined
    context.reflect.provide('tools', { register: (definition: import('@hydra/harness-tools').ToolDefinition) => {
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
