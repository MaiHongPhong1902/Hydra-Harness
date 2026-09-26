import { afterEach, expect, it, vi } from 'vitest'
import type { Model, Provider } from '@earendil-works/pi-ai'
import type { Context } from '@hydra1902/cordis'
import type { AuthorizationFlow, AuthorizationSession } from '@hydra1902/harness-authorization'
import { buildChatGptProfile, loginChatGpt, registerChatGptFlow } from '../src/chatgpt.ts'
import type { AccountPool } from '../src/accounts.ts'
import {
  DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS,
} from '@hydra1902/harness-llm-pi-ai'

const base = vi.hoisted(() => ({
  id: 'openai-codex', name: 'SDK provider',
  baseUrl: undefined as string | undefined,
  headers: undefined as Record<string, string> | undefined,
  auth: {},
  getModels: vi.fn<() => Model<'openai-codex-responses'>[]>(() => []),
  stream: vi.fn(), streamSimple: vi.fn(),
}))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({ openaiCodexProvider: () => base }))

afterEach(() => {
  base.getModels.mockReset().mockReturnValue([])
  base.baseUrl = undefined
  base.headers = undefined
  vi.clearAllMocks()
})

it('resolves unknown models against model, route, and harness capacities', async () => {
  const explicit = await buildChatGptProfile({ models: [{ id: 'new', name: 'New', contextWindow: 1000, maxTokens: 100 }] })
  expect(explicit.piProvider.getModels()).toMatchObject([{ id: 'new', name: 'New', contextWindow: 1000, maxTokens: 100 }])
  expect(explicit.configuredMaxTokens.get('new')).toBe(100)
  const route = await buildChatGptProfile({ models: [{ id: 'new' }], defaultContextWindow: 2000, defaultMaxTokens: 200 })
  expect(route.piProvider.getModels()).toMatchObject([{ name: 'new', contextWindow: 2000, maxTokens: 200 }])
  const defaults = await buildChatGptProfile({ models: [{ id: 'new' }] })
  expect(defaults.piProvider.getModels()).toMatchObject([{ contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }])
  expect(defaults).not.toHaveProperty('baseURL')
  expect(defaults.piProvider).not.toHaveProperty('headers')
})

it('detaches SDK metadata and routes both streaming methods to the SDK provider', async () => {
  const template = {
    id: 'known', name: 'Known', provider: base.id, api: 'openai-codex-responses', baseUrl: 'https://fixture.test',
    input: ['text', 'image'], reasoning: true, contextWindow: 4096, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    headers: { 'x-model': 'model' }, thinkingLevelMap: { low: 'low' },
  } satisfies Model<'openai-codex-responses'>
  base.getModels.mockReturnValue([template])
  base.baseUrl = template.baseUrl
  base.headers = { 'x-provider': 'provider' }
  const profile = await buildChatGptProfile({
    models: [{ id: 'unlisted' }], thinkingBudgets: { low: 512 }, streamIdleTimeoutMs: 1234, maxRequestImageBytes: 321,
  })
  const model = profile.piProvider.getModels()[0]! as Model<'openai-codex-responses'>
  expect(model).toMatchObject({ id: 'unlisted', provider: 'chatgpt', name: 'Known', headers: template.headers })
  expect(model.headers).not.toBe(template.headers)
  expect(model.thinkingLevelMap).not.toBe(template.thinkingLevelMap)
  expect(model.input).not.toBe(template.input)
  expect(profile).toMatchObject({
    baseURL: template.baseUrl, thinkingBudgets: { low: 512 },
    streamIdleTimeoutMs: 1234, maxRequestImageBytes: 321,
  })
  expect(profile.piProvider.headers).not.toBe(base.headers)
  const overridden = await buildChatGptProfile({ models: [{ id: 'known', contextWindow: 8192, maxTokens: 2048 }] })
  expect(overridden.piProvider.getModels()[0]).toMatchObject({ contextWindow: 8192, maxTokens: 2048 })
  const plainTemplate = { ...template, id: 'plain' }
  Reflect.deleteProperty(plainTemplate, 'thinkingLevelMap')
  Reflect.deleteProperty(plainTemplate, 'headers')
  base.getModels.mockReturnValue([plainTemplate])
  const plain = await buildChatGptProfile({ models: [{ id: 'plain' }] })
  expect(plain.piProvider.getModels()[0] as Model<'openai-codex-responses'>).toMatchObject({ id: 'plain' })
  const context = { messages: [] }
  const options = { temperature: 0 }
  const provider = profile.piProvider as Provider<'openai-codex-responses'>
  provider.stream(model, context, options)
  provider.streamSimple(model, context, options)
  for (const stream of [base.stream, base.streamSimple]) {
    expect(stream).toHaveBeenCalledWith({ ...model, provider: base.id }, context, options)
  }
})

it('registers the account inventory and reports when the SDK has no OAuth flow', async () => {
  const registerFlow = vi.fn<(flow: AuthorizationFlow) => void>()
  const pool = { accounts: { list: vi.fn(), remove: vi.fn() } } as unknown as AccountPool
  registerChatGptFlow({ authorization: { registerFlow } } as unknown as Context, pool)
  const flow = registerFlow.mock.calls[0]![0]
  expect(flow).toMatchObject({ key: 'llm-account-auth/chatgpt', accounts: pool.accounts, methods: [{ id: 'oauth' }] })
  const session: AuthorizationSession = { method: 'oauth', signal: new AbortController().signal, notify: vi.fn(), prompt: vi.fn() }
  await expect(flow.run(session)).rejects.toThrow('does not offer OAuth')
  await expect(loginChatGpt(session, pool)).rejects.toThrow('does not offer OAuth')
})
