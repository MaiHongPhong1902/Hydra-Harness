import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import type { Credential } from '@earendil-works/pi-ai'
import type { StreamChunk } from '@hydra/harness-llm'
import type { PiAiAdapterOptions } from '@hydra/harness-llm-pi-ai'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import { accountRecordKey, createAccountPool } from '../src/accounts.ts'
import { ChatGptAccountAdapter } from '../src/adapter.ts'
import { buildChatGptProfile } from '../src/chatgpt.ts'

const sdk = vi.hoisted(() => ({ create: vi.fn(), discover: vi.fn() }))
vi.mock('@hydra/harness-llm-pi-ai', async load => ({
  ...await load<typeof import('@hydra/harness-llm-pi-ai')>(),
  PiAiAdapter: sdk.create,
}))
vi.mock('../src/chatgpt.ts', async load => ({
  ...await load<typeof import('../src/chatgpt.ts')>(),
  discoverChatGptModels: sdk.discover,
}))

const contexts: Context[] = []
const grant = { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1000, accountId: 'fixture-account' } as const
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const delegate = {
  listModels: vi.fn(async () => [{ provider: 'chatgpt', id: 'test', name: 'Test' }]),
  resolveModel: vi.fn(async () => ({ provider: 'chatgpt', id: 'test' })),
  stream: vi.fn(async function* () { yield finish }),
}

beforeEach(() => {
  vi.clearAllMocks()
  sdk.create.mockImplementation(function() { return delegate })
  sdk.discover.mockResolvedValue([{ id: 'discovered' }])
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function poolFixture(credential?: Credential) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  const pool = createAccountPool({ ctx, key: accountRecordKey('chatgpt'), providerId: 'chatgpt', providerLabel: 'ChatGPT' })
  if (credential !== undefined) await pool.add('fixture', credential)
  return pool
}

it.each([false, true])('reuses the delegate and forwards its profile and attachment resolver: %s', async (lazy) => {
  const profile = await buildChatGptProfile({ models: [{ id: 'test' }], retryPolicy: { mode: 'normal' } })
  const pool = await poolFixture(grant)
  const loadProfile = vi.fn(async () => profile)
  const resolveAttachments = () => undefined
  const adapter = new ChatGptAccountAdapter({
    pool,
    profile: () => lazy ? undefined : profile,
    ...lazy ? { loadProfile, resolveAttachments } : {},
  })
  expect(adapter.providerInfo('chatgpt')).toEqual({ id: 'chatgpt', name: 'ChatGPT' })
  expect(await adapter.listModels('chatgpt')).toMatchObject([{ id: 'test' }])
  expect(await adapter.resolveModel('chatgpt', 'test')).toEqual({ provider: 'chatgpt', id: 'test' })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'chatgpt', model: 'test', messages: [] })) chunks.push(chunk)
  expect(chunks).toEqual([finish])
  expect(sdk.create).toHaveBeenCalledOnce()
  const config = sdk.create.mock.calls[0]?.[0] as PiAiAdapterOptions
  expect(config.profiles().get('chatgpt')).toBe(profile)
  await expect(config.resolveApiKey('chatgpt', profile)).resolves.toBeUndefined()
  expect(config.auth?.credentials).toBe(pool.credentials)
  expect(config.resolveAttachments).toBe(lazy ? resolveAttachments : undefined)
  expect(adapter.providerRetryPolicy('chatgpt')).toEqual(profile.retryPolicy)
  expect(adapter.providerRetryPolicy('other')).toBeUndefined()
  expect(loadProfile).toHaveBeenCalledTimes(lazy ? 1 : 0)
})

it('rejects a missing profile with and without a lazy resolver', async () => {
  const pool = await poolFixture()
  for (const loadProfile of [undefined, async () => undefined]) {
    const adapter = new ChatGptAccountAdapter({ pool, profile: () => undefined, ...(loadProfile === undefined ? {} : { loadProfile }) })
    expect(adapter.providerRetryPolicy('chatgpt')).toBeUndefined()
    await expect(adapter.listModels('chatgpt')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  }
  expect(sdk.create).not.toHaveBeenCalled()
})

it.each([
  undefined,
  { type: 'api_key', key: 'fixture' },
  { ...grant, access: '' },
  { type: 'oauth', access: 'fixture', refresh: 'refresh', expires: 1000 },
  { ...grant, accountId: '' },
] satisfies (Credential | undefined)[])('rejects discovery without usable account credentials: %j', async (credential) => {
  const pool = await poolFixture(credential === undefined ? undefined : grant)
  if (credential !== undefined) vi.spyOn(pool.credentials, 'read').mockResolvedValue(credential)
  const adapter = new ChatGptAccountAdapter({ pool, profile: () => undefined })
  await expect(adapter.discoverModels()).rejects.toMatchObject({
    code: credential === undefined ? 'MISSING_CREDENTIAL' : 'INVALID_CREDENTIAL',
  })
  expect(sdk.discover).not.toHaveBeenCalled()
})

it('discovers with account-scoped credentials and forwards cancellation', async () => {
  const pool = await poolFixture(grant)
  const adapter = new ChatGptAccountAdapter({ pool, profile: () => undefined })
  for (const signal of [undefined, new AbortController().signal]) {
    expect(await adapter.discoverModels(signal)).toEqual([{ id: 'discovered' }])
    expect(sdk.discover).toHaveBeenLastCalledWith({ accessToken: 'access', accountId: 'fixture-account', ...signal ? { signal } : {} })
  }
  await expect(adapter.discoverModels(AbortSignal.abort(new Error('before discovery')))).rejects.toThrow('before discovery')
  const controller = new AbortController()
  const accounts = await pool.accounts.list()
  vi.spyOn(pool.accounts, 'list').mockImplementation(async () => {
    controller.abort(new Error('after accounts'))
    return accounts
  })
  await expect(adapter.discoverModels(controller.signal)).rejects.toThrow('after accounts')
})
