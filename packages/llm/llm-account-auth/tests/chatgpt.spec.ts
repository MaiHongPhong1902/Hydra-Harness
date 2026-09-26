/** ChatGPT OAuth bridging against the SDK provider and the durable account store. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@hydra1902/cordis'
import Credentials from '@hydra1902/harness-credentials-local'
import type { AuthorizationPrompt, AuthorizationSession } from '@hydra1902/harness-authorization'
import type { AuthEvent, AuthInteraction, AuthPrompt, OAuthCredential } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { accountRecordKey, createAccountPool } from '../src/accounts.ts'
import {
  buildChatGptProfile, CHATGPT_MODELS_CLIENT_VERSION, discoverChatGptModels, loginChatGpt,
} from '../src/chatgpt.ts'

const oauth = vi.hoisted(() => ({ login: vi.fn() }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', async (load) => {
  const original = await load<typeof import('@earendil-works/pi-ai/providers/openai-codex')>()
  return {
    ...original,
    openaiCodexProvider: () => {
      const provider = original.openaiCodexProvider()
      return { ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth, login: oauth.login } } }
    },
  }
})

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  oauth.login.mockReset()
  vi.restoreAllMocks()
})

async function poolFixture() {
  root = await mkdtemp(join(tmpdir(), 'hydra-chatgpt-login-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Credentials, { path: join(root, '.credentials.yaml'), debounceMs: 10 })
  return createAccountPool({ ctx, key: accountRecordKey('chatgpt'), providerId: 'chatgpt', providerLabel: 'ChatGPT' })
}

const grant: OAuthCredential = { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: 123456 }

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`
}

it('projects the SDK catalog onto the ChatGPT route', async () => {
  const profile = await buildChatGptProfile({})
  const models = profile.piProvider.getModels()
  expect(models.length).toBeGreaterThan(0)
  expect(models.every(model => model.provider === 'chatgpt' && model.api === 'openai-codex-responses')).toBe(true)
  const model = models[0]!
  const custom = await buildChatGptProfile({ models: [{ id: model.id, name: 'My model', maxTokens: 2048 }] })
  expect(custom.piProvider.getModels()).toMatchObject([{ id: model.id, name: 'My model', maxTokens: 2048 }])
})

it('carries pi-ai performance controls into the ChatGPT route', async () => {
  const profile = await buildChatGptProfile({
    reasoning: 'low',
    cacheRetention: 'long',
    transport: 'sse',
    timeoutMs: 7_000,
    websocketConnectTimeoutMs: 3_000,
    retryPolicy: {
      mode: 'always',
      backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
    },
  })

  expect(profile).toMatchObject({
    reasoning: 'low',
    cacheRetention: 'long',
    transport: 'sse',
    timeoutMs: 7_000,
    websocketConnectTimeoutMs: 3_000,
    retryPolicy: {
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    },
  })
})

it('asks for the account model catalog with a client version the endpoint accepts', async () => {
  // A partial version ("0.85") is refused outright and a stale one is answered
  // with an empty catalog, so the value has to be a full release version.
  expect(CHATGPT_MODELS_CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/u)
})

it('fetches the account model catalog from ChatGPT', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ models: [
    { slug: 'live-model', display_name: 'Live model', context_window: 128000 },
    { id: 'live-model' },
    { id: 'second-model', max_output_tokens: 4096 },
  ] }))
  await expect(discoverChatGptModels({
    accessToken: 'access-token', accountId: 'account-id',
  })).resolves.toEqual([
    { id: 'live-model', name: 'Live model', contextWindow: 128000 },
    { id: 'second-model', maxTokens: 4096 },
  ])
  // The endpoint requires the client version and answers a missing one with
  // HTTP 400; the version also selects the catalog it serves.
  expect(fetch).toHaveBeenCalledWith(
    `https://chatgpt.com/backend-api/codex/models?client_version=${CHATGPT_MODELS_CLIENT_VERSION}`,
    expect.objectContaining({ method: 'GET' }),
  )
  const init = fetch.mock.calls[0]?.[1]
  const headers = new Headers(init?.headers)
  expect(headers.get('authorization')).toBe('Bearer access-token')
  expect(headers.get('chatgpt-account-id')).toBe('account-id')
})

it('filters hidden, unsupported, and malformed model rows and reads alternate metadata fields', async () => {
  const signal = new AbortController().signal
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [
    null, [], 'model', {}, { id: 'hidden', visibility: 'hidden' }, { id: 'unsupported', supported_in_api: false },
    { id: '', slug: 'visible', name: 'Visible', context_window: 0, context_length: 8192, max_output_tokens: 1.5, max_tokens: 1024 },
    { id: 'bare', context_window: '4096', max_tokens: -1 },
  ] }))
  await expect(discoverChatGptModels({ accessToken: 'token', accountId: 'account', baseURL: 'https://fixture.test///', signal }))
    .resolves.toEqual([{ id: 'visible', name: 'Visible', contextWindow: 8192, maxTokens: 1024 }, { id: 'bare' }])
  expect(fetch).toHaveBeenCalledWith(
    expect.stringMatching(/^https:\/\/fixture.test\/codex\/models\?/u), expect.objectContaining({ signal }),
  )
})

it.each([[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER'], [400, 'INVALID_REQUEST']] as const)(
  'classifies model discovery HTTP %s and cancels the error body', async (status, code) => {
    const response = new Response('failure', { status })
    const cancel = vi.spyOn(response.body!, 'cancel')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await expect(discoverChatGptModels({ accessToken: 'token', accountId: 'account' }))
      .rejects.toMatchObject({ code, failure: { status } })
    expect(cancel).toHaveBeenCalledOnce()
  },
)

it('handles HTTP failures without a response body', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }))
  await expect(discoverChatGptModels({ accessToken: 'token', accountId: 'account' }))
    .rejects.toMatchObject({ code: 'SERVER' })
})

it.each([null, [], 1, {}, { models: {} }])('rejects discovery payload without a model list: %j', async (payload) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload))
  await expect(discoverChatGptModels({ accessToken: 'token', accountId: 'account' }))
    .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
})

it('distinguishes invalid JSON, transport failure, and caller cancellation', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{'))
  const request = { accessToken: 'token', accountId: 'account' }
  await expect(discoverChatGptModels(request)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  const cause = new Error('connection reset')
  fetch.mockRejectedValue(cause)
  await expect(discoverChatGptModels(request)).rejects.toMatchObject({ code: 'TRANSPORT', cause })
  await expect(discoverChatGptModels({ ...request, signal: AbortSignal.abort() }))
    .rejects.toMatchObject({ code: 'ABORTED', cause })
})

it('masks the manual code prompt and stores the returned OAuth grant', async () => {
  const pool = await poolFixture()
  const prompt = vi.fn(async (_request: AuthorizationPrompt) => 'test-code')
  const session: AuthorizationSession = {
    method: 'oauth', signal: new AbortController().signal,
    notify: vi.fn(),
    prompt,
  }
  oauth.login.mockImplementation(async (interaction: AuthInteraction) => {
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/test' })
    await interaction.prompt({ type: 'manual_code', message: 'Paste the callback' })
    return { ...grant, email: 'chatgpt@example.test' }
  })
  await loginChatGpt(session, pool)
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ kind: 'secret', message: 'Paste the callback' }))
  expect(await pool.accounts.list()).toMatchObject([{ label: 'chatgpt@example.test' }])
})

it('relays SDK notices and prompt kinds without losing withdrawal signals', async () => {
  const pool = await poolFixture()
  const signal = new AbortController().signal
  const notify = vi.fn<(event: unknown) => void>()
  const prompt = vi.fn(async (_request: unknown): Promise<string> => 'answer')
  const events: AuthEvent[] = [
    { type: 'info', message: 'Help', links: [{ url: 'https://fixture.test/help' }] },
    { type: 'info', message: 'Wait' },
    { type: 'auth_url', url: 'https://fixture.test/login', instructions: 'Log in' },
    { type: 'device_code', userCode: '1234', verificationUri: 'https://fixture.test/device' },
    { type: 'progress', message: 'Connected' },
    { type: 'future-sdk-event' } as unknown as AuthEvent,
  ]
  const prompts: AuthPrompt[] = [
    { type: 'select', message: 'Account', options: [{ id: 'work', label: 'Work' }] },
    { type: 'secret', message: 'Token', placeholder: 'token', signal },
    { type: 'text', message: 'Workspace', placeholder: 'name' },
    { type: 'text', message: 'Label' },
  ]
  oauth.login.mockImplementation(async (interaction: AuthInteraction) => {
    expect(interaction.signal).toBe(signal)
    for (const event of events) interaction.notify(event)
    for (const item of prompts) await interaction.prompt(item)
    return grant
  })
  await loginChatGpt({ method: 'oauth', signal, notify, prompt }, pool)
  expect(notify.mock.calls.map(([notice]) => notice)).toEqual([
    { message: 'Help', url: 'https://fixture.test/help' },
    { message: 'Wait' },
    { message: 'Log in', url: 'https://fixture.test/login' },
    { message: 'Enter this code on the verification page to finish signing in.', url: 'https://fixture.test/device', code: '1234' },
    { message: 'Connected' },
    { message: 'Signing in…' },
  ])
  expect(prompt.mock.calls.map(([request]) => request)).toEqual([
    { kind: 'select', message: 'Account', options: [{ id: 'work', label: 'Work' }] },
    { kind: 'secret', message: 'Token', placeholder: 'token', signal },
    { kind: 'text', message: 'Workspace', placeholder: 'name' },
    { kind: 'text', message: 'Label' },
  ])
})

it('uses the ChatGPT profile claim for the automatic account label', async () => {
  const pool = await poolFixture()
  const session: AuthorizationSession = {
    method: 'oauth', signal: new AbortController().signal,
    notify: vi.fn(), prompt: async () => 'test-code',
  }
  oauth.login.mockResolvedValue({
    ...grant,
    access: fakeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-id' },
      'https://api.openai.com/profile': { email: 'profile@example.test' },
    }),
    accountId: 'workspace-id',
  })
  await loginChatGpt(session, pool)
  expect(await pool.accounts.list()).toMatchObject([{ label: 'profile@example.test' }])
})

it('rejects a late SDK login result after cancellation without storing an account', async () => {
  const pool = await poolFixture()
  const controller = new AbortController()
  const pending = Promise.withResolvers<OAuthCredential>()
  oauth.login.mockReturnValue(pending.promise)
  const login = loginChatGpt({
    method: 'oauth', signal: controller.signal,
    notify: () => undefined, prompt: async () => 'Cancelled',
  }, pool)
  const rejected = expect(login).rejects.toMatchObject({ code: 'ABORTED' })
  await vi.waitFor(() => { expect(oauth.login).toHaveBeenCalledOnce() })
  controller.abort()
  pending.resolve(grant)
  await rejected
  expect(await pool.accounts.list()).toEqual([])
})

it('serializes logout after an active refresh and prevents a stale refresh from restoring it', async () => {
  const pool = await poolFixture()
  const first = await pool.add('First', grant)
  const sibling = await pool.add('Sibling', { ...grant, access: 'sibling-access' })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const refresh = pool.withAccount(first.id, () => pool.credentials.modify('chatgpt', async (current) => {
    entered.resolve(undefined)
    await release.promise
    expect(current).toMatchObject({ access: 'test-access' })
    return { ...grant, access: 'refreshed-access' }
  }))
  await entered.promise
  const logout = pool.accounts.remove(first.id)
  release.resolve(undefined)
  await Promise.all([refresh, logout])
  expect(await pool.accounts.list()).toEqual([sibling])
  await expect(pool.withAccount(first.id, () => pool.credentials.modify('chatgpt', async () => grant)))
    .rejects.toMatchObject({ code: 'ACCOUNT_GONE' })
  await pool.withAccount(sibling.id, async () => {
    expect(await pool.credentials.read('chatgpt')).toMatchObject({ access: 'sibling-access' })
  })
})
