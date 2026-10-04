/** Native SDK OAuth delegation, account isolation, and paged provider catalogs. */
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import type { AuthInteraction, OAuthCredential } from '@earendil-works/pi-ai'
import { CallId, createUserMessage, type StreamChunk } from '@hydraharness/harness-llm'
import type { AuthorizationSession } from '@hydraharness/harness-authorization'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import { createAccountPool, accountRecordKey } from '../src/accounts.ts'
import { buildSdkAccountProfile, discoverSdkAccountModels, loadSdkAccountProvider, loginSdkAccount, type SdkAccountProvider } from '../src/sdk-accounts.ts'
import { PiAiAccountAdapter } from '../src/adapter.ts'

const oauth = vi.hoisted(() => ({
  login: vi.fn<(interaction: AuthInteraction) => Promise<OAuthCredential>>(), refresh: vi.fn(), missingOAuth: false, missingEndpoint: false,
}))
vi.mock('@earendil-works/pi-ai/providers/anthropic', async (load) => {
  const native = await load<typeof import('@earendil-works/pi-ai/providers/anthropic')>()
  return { anthropicProvider: () => {
    const provider = { ...native.anthropicProvider() }
    if (oauth.missingEndpoint) delete provider.baseUrl
    return { ...provider, auth: oauth.missingOAuth ? {} : {
      oauth: { ...provider.auth.oauth, login: oauth.login, refresh: oauth.refresh },
    } }
  } }
})
vi.mock('@earendil-works/pi-ai/providers/xai', async (load) => {
  const native = await load<typeof import('@earendil-works/pi-ai/providers/xai')>()
  return { xaiProvider: () => {
    const provider = native.xaiProvider()
    return { ...provider, auth: { oauth: { ...provider.auth.oauth, login: oauth.login, refresh: oauth.refresh } } }
  } }
})
vi.mock('@earendil-works/pi-ai/providers/kimi-coding', async (load) => {
  const native = await load<typeof import('@earendil-works/pi-ai/providers/kimi-coding')>()
  return { kimiCodingProvider: () => {
    const provider = native.kimiCodingProvider()
    return { ...provider, auth: { oauth: { ...provider.auth.oauth, login: oauth.login, refresh: oauth.refresh } } }
  } }
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  oauth.missingOAuth = false
  oauth.missingEndpoint = false
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function poolFor(provider: SdkAccountProvider) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(MemoryCredentials)
  return createAccountPool({ ctx, key: accountRecordKey(provider), providerId: provider, providerLabel: provider })
}
const grant = () => ({ type: 'oauth' as const, access: 'sk-ant-oat-fixture', refresh: 'refresh', expires: Date.now() + 60_000 })

it.each(['claude', 'xai-account', 'kimi'] as const)('runs %s SDK login through authorization and stores only in its own pool', async (provider) => {
  const pool = await poolFor(provider)
  const notify = vi.fn()
  const prompt = vi.fn(async () => 'code')
  const session: AuthorizationSession = { method: 'oauth', signal: new AbortController().signal, notify, prompt }
  oauth.login.mockImplementation(async (interaction) => {
    interaction.notify({ type: 'device_code', verificationUri: 'https://login.test', userCode: 'CODE' })
    await interaction.prompt({ type: 'manual_code', message: 'Paste code' })
    return grant()
  })
  await loginSdkAccount(provider, session, pool)
  expect(notify).toHaveBeenCalledWith({ message: 'Enter this code on the verification page to finish signing in.', url: 'https://login.test', code: 'CODE' })
  expect(prompt).toHaveBeenCalledWith({ kind: 'secret', message: 'Paste code' })
  const account = (await pool.accounts.list())[0]!
  expect(await pool.withAccount(account.id, () => pool.credentials.read(provider))).toMatchObject({ type: 'oauth', access: 'sk-ant-oat-fixture' })
  expect(await pool.credentials.read(provider)).toBeUndefined()
  expect(await pool.withAccount(account.id, () => pool.credentials.read('other'))).toBeUndefined()
})

it('does not store a completed SDK grant after the authorization attempt is canceled', async () => {
  const pool = await poolFor('claude')
  const controller = new AbortController()
  oauth.login.mockImplementation(async () => { controller.abort(new Error('cancel')); return grant() })
  await expect(loginSdkAccount('claude', { method: 'oauth', signal: controller.signal, notify: vi.fn(), prompt: vi.fn() }, pool)).rejects.toThrow('cancel')
  expect(await pool.accounts.list()).toEqual([])
})

it.each(['claude', 'xai-account', 'kimi'] as const)('discovers and refreshes %s using its native OAuth token and API route', async (provider) => {
  const pool = await poolFor(provider)
  const account = await pool.add(undefined, { ...grant(), expires: 1 })
  oauth.refresh.mockResolvedValue({ ...grant(), access: 'renewed' })
  const profile = await buildSdkAccountProfile(provider, {})
  const calls: Array<{ url: URL; headers: Headers }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: URL, init: RequestInit) => {
    calls.push({ url: new URL(input.href), headers: new Headers(init.headers) })
    if (input.pathname.endsWith('/image-generation-models')) return Response.json({ models: [{ id: 'fresh-raster-alias' }] })
    if (input.pathname.endsWith('/video-generation-models')) return Response.json({ models: [{ id: 'fresh-motion-alias' }] })
    return Response.json({ data: [{ id: provider === 'xai-account' ? 'grok-imagine-image-2.0' : 'model', display_name: 'Model' }],
      ...provider === 'claude' && calls.length === 1 ? { has_more: true, last_id: 'page2' } : {} })
  }))
  const rows = await discoverSdkAccountModels(provider, pool, profile)
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer renewed')
  expect(calls[0]!.url.pathname).toBe(provider === 'kimi' ? '/coding/v1/models' : '/v1/models')
  expect(calls[0]!.url.hostname).toBe(provider === 'claude' ? 'api.anthropic.com' : provider === 'xai-account' ? 'api.x.ai' : 'api.kimi.com')
  if (provider === 'kimi') expect(calls[0]!.url.pathname).toBe('/coding/v1/models')
  if (provider === 'claude') {
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url.searchParams.get('after_id')).toBe('page2')
    expect(calls[0]!.headers.get('anthropic-version')).toBe('2023-06-01')
  }
  if (provider === 'xai-account') {
    expect(rows).toEqual([
      { id: 'grok-imagine-image-2.0', name: 'Model', endpoints: ['images/generations'] },
      { id: 'fresh-raster-alias', endpoints: ['images/generations'] },
      { id: 'fresh-motion-alias', endpoints: ['videos'] },
    ])
    expect(calls.map(call => call.url.pathname)).toEqual(['/v1/models', '/v1/image-generation-models', '/v1/video-generation-models'])
    expect(calls.every(call => call.headers.get('authorization') === 'Bearer renewed')).toBe(true)
  }
  expect(oauth.refresh).toHaveBeenCalledOnce()
  expect(await pool.withAccount(account.id, () => pool.credentials.read(provider))).toMatchObject({ access: 'renewed' })
})

it('rejects repeating catalog pagination and an empty account pool', async () => {
  const pool = await poolFor('claude')
  const profile = await buildSdkAccountProfile('claude', {})
  await expect(discoverSdkAccountModels('claude', pool, profile)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  await pool.add(undefined, grant())
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [], has_more: true, last_id: 'repeat' })))
  await expect(discoverSdkAccountModels('claude', pool, profile)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
})

it('refuses SDK providers that no longer supply native OAuth or an endpoint', async () => {
  const pool = await poolFor('claude')
  oauth.missingOAuth = true
  await expect(loginSdkAccount('claude', { method: 'oauth', signal: new AbortController().signal, notify: vi.fn(), prompt: vi.fn() }, pool)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  await expect(buildSdkAccountProfile('claude', {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  oauth.missingOAuth = false
  oauth.missingEndpoint = true
  await expect(buildSdkAccountProfile('claude', {})).rejects.toMatchObject({ code: 'NO_ADAPTER' })
})

it('retains every configured request control and resolves fresh models in the native Messages protocol', async () => {
  const profile = await buildSdkAccountProfile('kimi', { models: [{ id: 'fresh-kimi-model' }], defaultContextWindow: 64000, defaultMaxTokens: 2048,
    streamIdleTimeoutMs: 1234, reasoning: 'low', thinkingBudgets: { low: 1024 }, cacheRetention: 'none', transport: 'sse',
    timeoutMs: 2345, websocketConnectTimeoutMs: 3456, retryPolicy: { mode: 'normal' }, maxRequestImageBytes: 4096 })
  expect(profile).toMatchObject({ defaultContextWindow: 64000, defaultMaxTokens: 2048, streamIdleTimeoutMs: 1234,
    reasoning: 'low', thinkingBudgets: { low: 1024 }, cacheRetention: 'none', transport: 'sse', timeoutMs: 2345,
    websocketConnectTimeoutMs: 3456, retryPolicy: { mode: 'normal' }, maxRequestImageBytes: 4096 })
  expect(profile.piProvider.getModels()).toMatchObject([{ id: 'fresh-kimi-model', provider: 'kimi', api: 'anthropic-messages' }])
})

it('rejects discovery without OAuth authentication or a native catalog endpoint', async () => {
  const pool = await poolFor('claude')
  await pool.add('Unusable', { type: 'api_key', key: 'unsupported' })
  const profile = await buildSdkAccountProfile('claude', {})
  await expect(discoverSdkAccountModels('claude', pool, profile)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  const valid = await poolFor('claude')
  await valid.add(undefined, grant())
  const missingBase = { ...profile }
  delete missingBase.baseURL
  await expect(discoverSdkAccountModels('claude', valid, missingBase)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  await expect(discoverSdkAccountModels('claude', valid, { ...profile, baseURL: 'http://remote.test' })).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })
})

it.each([
  [() => new Response('private provider body', { status: 403 }), 'DISCOVERY_FAILED'],
  [() => Response.json({}), 'DISCOVERY_FAILED'],
  [() => Response.json({ data: [null] }), 'DISCOVERY_FAILED'],
  [() => Response.json({ data: [{}] }), 'DISCOVERY_FAILED'],
  [() => Response.json({ data: [{ id: '' }] }), 'DISCOVERY_FAILED'],
  [() => Response.json({ data: [], has_more: true }), 'DISCOVERY_FAILED'],
] as const)('rejects failed or malformed SDK model listings %#', async (reply, code) => {
  const pool = await poolFor('claude')
  await pool.add(undefined, grant())
  vi.stubGlobal('fetch', vi.fn(async () => reply()))
  await expect(discoverSdkAccountModels('claude', pool, await buildSdkAccountProfile('claude', {}))).rejects.toMatchObject({ code })
})

it('retains models without optional display names and uses caller cancellation', async () => {
  const pool = await poolFor('kimi')
  await pool.add(undefined, grant())
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
    expect(init.signal?.aborted).toBe(false)
    return Response.json({ data: [{ id: 'kimi-model' }] })
  }))
  expect(await discoverSdkAccountModels('kimi', pool, await buildSdkAccountProfile('kimi', {}), controller.signal)).toEqual([{ id: 'kimi-model' }])
})

it('uses selected xAI OAuth credentials for images and preserves the actual returned JPEG format', async () => {
  const pool = await poolFor('xai-account')
  await pool.add('Unusable', { type: 'api_key', key: 'unsupported-account-record' })
  await pool.add('Connected', grant())
  const profile = await buildSdkAccountProfile('xai-account', { models: [{ id: 'grok-imagine-image-2.0' }, { id: 'grok-imagine-video' }] })
  const adapter = new PiAiAccountAdapter({ provider: 'xai-account', pool, profile: () => profile })
  const image = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]).toString('base64')
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.href).toBe('https://api.x.ai/v1/images/generations')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-ant-oat-fixture')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'grok-imagine-image-2.0', prompt: 'A tree', n: 1, aspect_ratio: '2:3', response_format: 'b64_json', quality: 'medium' })
    return Response.json({ data: [{ b64_json: image }] })
  })
  vi.stubGlobal('fetch', fetcher)
  const response = await adapter.requestGeneration({ provider: 'xai-account', model: 'grok-imagine-image-2.0', endpoint: 'images/generations',
    body: { prompt: 'A tree', n: 1, size: '1024x1536', quality: 'medium', output_format: 'png', background: 'auto' }, signal: new AbortController().signal, maxResponseBytes: 4096 })
  expect(await response.json()).toMatchObject({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: image } }] } }] })
  expect(fetcher).toHaveBeenCalledOnce()
})

it('submits xAI video jobs as JSON and rejects unsupported controls before HTTP', async () => {
  const pool = await poolFor('xai-account')
  await pool.add(undefined, grant())
  const profile = await buildSdkAccountProfile('xai-account', { models: [{ id: 'grok-imagine-video' }, { id: 'grok-imagine-image-2.0' }] })
  const adapter = new PiAiAccountAdapter({ provider: 'xai-account', pool, profile: () => profile })
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.href).toBe('https://api.x.ai/v1/videos/generations')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'grok-imagine-video', prompt: 'A tree', duration: 6, aspect_ratio: '16:9' })
    return Response.json({ request_id: 'accepted-job' })
  })
  vi.stubGlobal('fetch', fetcher)
  const base = { provider: 'xai-account', signal: new AbortController().signal, maxResponseBytes: 4096 }
  const response = await adapter.requestGeneration({ ...base, model: 'grok-imagine-video', endpoint: 'videos', body: { prompt: 'A tree', seconds: '6', size: '1280x720' } })
  expect(await response.json()).toEqual({ request_id: 'accepted-job' })
  fetcher.mockClear()
  await expect(adapter.requestGeneration({ ...base, model: 'grok-imagine-video', endpoint: 'videos', body: { seconds: 'NaN' } })).rejects.toMatchObject({ code: 'INVALID_GENERATION' })
  await expect(adapter.requestGeneration({ ...base, model: 'grok-imagine-image-2.0', endpoint: 'images/generations', body: { prompt: 'A tree', background: 'transparent' } })).rejects.toMatchObject({ code: 'UNSUPPORTED_GENERATION' })
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['claude', 'xai-account', 'kimi'] as const)('streams %s text and tool calls over real native HTTP with the selected account', async (provider) => {
  const pool = await poolFor(provider)
  await pool.add(undefined, grant())
  const native = await loadSdkAccountProvider(provider)
  const model = native.getModels().find(item => provider !== 'xai-account' || item.api === 'openai-completions')
  if (model === undefined) throw new Error('native provider has no chat model')
  const requests: Array<{ path: string; body: Record<string, unknown>; auth: string | undefined }> = []
  const server = createServer((request, response) => { void (async () => {
    const bytes: Buffer[] = []
    for await (const chunk of request) bytes.push(Buffer.from(chunk as Uint8Array))
    requests.push({ path: request.url!, body: JSON.parse(Buffer.concat(bytes).toString()) as Record<string, unknown>, auth: request.headers.authorization ?? request.headers['x-api-key'] as string | undefined })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const events = provider === 'xai-account' ? [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'A tree.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tree-call', type: 'function', function: { name: 'image', arguments: '{"prompt":"A tree"}' } }] }, finish_reason: 'tool_calls' }] },
    ] : [
      { type: 'message_start', message: { id: 'message', type: 'message', role: 'assistant', model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A tree.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tree-call', name: 'image', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"prompt":"A tree"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ]
    for (const event of events) response.write(`${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
    response.end(provider === 'xai-account' ? 'data: [DONE]\n\n' : '')
  })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error(String(error))) }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no fixture port')
  const profile = await buildSdkAccountProfile(provider, { endpoint: `http://127.0.0.1:${address.port}${provider === 'xai-account' ? '/v1' : ''}`, models: [{ id: model.id }] })
  const adapter = new PiAiAccountAdapter({ provider, pool, profile: () => profile })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider, model: model.id, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Create a tree.' }] })],
    tools: [{ name: 'image', description: 'Create an image', parameters: { type: 'object', properties: { prompt: { type: 'string' } } } }],
  })) chunks.push(chunk)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.path).toBe(provider === 'xai-account' ? '/v1/chat/completions' : '/v1/messages')
  expect(requests[0]!.auth).toContain('sk-ant-oat-fixture')
  expect(requests[0]!.body['tools']).toEqual(expect.any(Array))
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'A tree.' }))
  expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block))
    .toContainEqual(expect.objectContaining({ type: 'tool-call', id: CallId('tree-call'), name: 'image' }))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  const resolved = profile.piProvider.getModels()[0]!
  const direct = profile.piProvider.stream(resolved, { messages: [{ role: 'user', content: 'Create a tree.', timestamp: Date.now() }] }, { apiKey: 'sk-ant-oat-fixture' })
  for await (const _event of direct) { /* Drain the native full stream alongside the adapter's simple-stream route. */ }
  expect((await direct.result()).stopReason).toBe('toolUse')
  expect(requests).toHaveLength(2)
})
