/** HTTP normalization, credential isolation, and hot provider selection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Context } from '@hydraharness/cordis'
import WebRuntime, { normalizedSearchUrl } from '@hydraharness/harness-web'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@hydraharness/harness-settings'
import * as deepseek from '@hydraharness/harness-web-search-deepseek'
import * as http from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  static initial: Record<string, unknown> = {}
  readonly writable = true
  doc: Record<string, unknown> = structuredClone(MemorySettings.initial)
  protected async load() { return this.doc }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>) { this.doc[ns] = section }
}

const ns = settingsNamespace('web-search')
const customNs = settingsNamespace('web-search-custom')
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  MemorySettings.initial = {}
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function boot(initial: Record<string, unknown> = {}) {
  MemorySettings.initial = initial
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(WebRuntime, { requireSearchSelection: true })
  await ctx.plugin(deepseek, {})
  await ctx.plugin(http, {})
  return ctx
}

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }) }

describe('search provider selection', () => {
  it('uses operator defaults without settings and resolves the credential service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WebRuntime)
    const resolve = vi.fn(async () => ({ value: 'service-secret' }))
    ctx.provide('credentials', { resolve } as never)
    http.apply(ctx, {})
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ organic: [] }))
    await ctx.web.testSearchProvider('serper')
    expect(resolve).toHaveBeenCalledWith('SERPER_API_KEY')
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('X-API-KEY')).toBe('service-secret')
  })

  it('keeps a fresh installation unselected even with a chat credential', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'chat-key')
    const ctx = await boot()
    expect(ctx.web.searchPreferences()?.provider).toBe('')
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    expect(ctx.web.listSearchProviders().map(item => item.displayName)).toEqual(['DeepSeek', 'Serper.dev', 'Other'])
  })

  it('persists an explicit legacy DeepSeek choice and respects a later empty selection', async () => {
    const ctx = await boot({ 'web-search-deepseek': { maxUses: 3 } })
    expect(ctx.web.searchPreferences()?.provider).toBe('deepseek-official')
    expect((ctx.settings as MemorySettings).doc['web-search']).toEqual({ provider: 'deepseek-official' })
    const fresh = await boot({ 'web-search': { provider: '' }, 'web-search-deepseek': { maxUses: 3 } })
    expect(fresh.web.searchPreferences()?.provider).toBe('')
  })

  it('switches providers on the next search without deleting stored configuration', async () => {
    vi.stubEnv('SERPER_API_KEY', 'serper-secret')
    vi.stubEnv('DEEPSEEK_API_KEY', 'deepseek-secret')
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => (input instanceof Request ? input.url : input.toString()).includes('serper')
      ? response({ organic: [{ title: 'Docs', link: 'https://example.com/docs', snippet: 'text', position: 1 }] })
      : response({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://deepseek.test/docs', title: 'DS' }] }] }))
    const ctx = await boot()
    await ctx.settings.update(ns, { provider: 'serper' })
    const result = await ctx.web.search({ query: 'Docs', maxResults: 8 })
    expect(result.sources[0]).toMatchObject({ provider: 'serper', title: 'Docs', position: 1 })
    const init = fetch.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get('X-API-KEY')).toBe('serper-secret')
    expect(JSON.parse(init?.body as string)).toEqual({ q: 'Docs', num: 8 })
    await ctx.settings.update(ns, { provider: 'deepseek-official' })
    await ctx.web.search({ query: 'Docs' })
    expect(fetch.mock.calls[1]?.[0]).toContain('deepseek.com/anthropic')
    expect(ctx.settings.get(settingsNamespace('web-search-serper'))).toMatchObject({ apiKeyEnv: 'SERPER_API_KEY' })
    await ctx.settings.update(ns, { enabled: false })
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('uses request locale hints and ignores saved locale defaults', async () => {
    vi.stubEnv('SERPER_API_KEY', 'serper-secret')
    const ctx = await boot({ 'web-search': { provider: 'serper' }, 'web-search-serper': { country: 'us', language: 'en' } })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ organic: [] }))
    await ctx.web.search({ query: 'Tin tại Việt Nam', country: 'vn', language: 'vi' })
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ q: 'Tin tại Việt Nam', num: 8, gl: 'vn', hl: 'vi' })
    await ctx.web.search({ query: 'Documentation' })
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({ q: 'Documentation', num: 8 })
    for (const provider of ctx.web.listSearchProviders()) {
      expect(provider.fields.map(field => field.key)).not.toContain('country')
      expect(provider.fields.map(field => field.key)).not.toContain('language')
    }
  })

  it('rejects unsupported search types before network work', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const ctx = await boot({ 'web-search': { provider: 'serper' } })
    await expect(ctx.web.search({ query: 'q', type: 'images' })).rejects.toThrow('does not support images search')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('removes both provider registrations when the plugin is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WebRuntime)
    const fiber = await ctx.plugin(http, {})
    expect(ctx.web.listSearchProviders()).toHaveLength(2)
    await fiber.dispose()
    expect(ctx.web.listSearchProviders()).toEqual([])
  })
})

describe('custom JSON provider', () => {
  it.each([
    { endpoint: 'broken' }, { endpoint: 'https://example.test/#fragment' },
    { endpoint: 'https://example.test/?token=secret' },
    { staticBody: '{' }, { staticBody: 'null' }, { staticBody: '[]' },
    { staticBody: '{"nested":{"constructor":{}}}' },
    { headerRefs: '{"Host":"KEY"}' }, { headerRefs: '{"X-Token":42}' },
  ])('rejects unsafe provider settings %j', (patch) => {
    expect(() => { http.validateSearchConfig(http.CustomConfig(patch)) }).toThrow()
  })

  it('maps nested request fields and custom credential headers without mutating saved JSON', async () => {
    vi.stubEnv('CUSTOM_HEADER_KEY', 'header-secret')
    const ctx = await boot({ 'web-search': { provider: 'custom' } })
    const staticBody = JSON.stringify({ request: { keep: true }, limits: [], locale: null })
    await ctx.settings.update(customNs, {
      endpoint: 'https://custom.test/search', auth: 'none', queryField: 'request.query', limitField: 'limits.count',
      countryField: 'locale.country', languageField: 'locale.language', typeField: 'kind', dateField: 'date',
      headerRefs: '{"X-Token":"CUSTOM_HEADER_KEY"}', staticBody,
      publishedAtField: 'date', positionField: 'rank', scoreField: 'score',
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ results: [{
      url: 'https://example.test/', title: null, snippet: null, date: '2026-09-23', rank: 1, score: 0,
    }] }))
    await expect(ctx.web.search({ query: 'q', maxResults: 2, country: 'vn', language: 'vi', date: 'week' }))
      .resolves.toMatchObject({ sources: [{ publishedAt: '2026-09-23', position: 1, score: 0 }] })
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('X-Token')).toBe('header-secret')
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      request: { keep: true, query: 'q' }, limits: { count: 2 }, locale: { country: 'vn', language: 'vi' }, kind: 'web', date: 'week',
    })
    expect(ctx.settings.get(customNs)).toMatchObject({ staticBody })
  })

  it.each([
    { url: 1 }, { url: 'broken' }, { url: 'file:///tmp/file' },
    { url: 'https://example.test/', title: 1 },
    { url: 'https://example.test/', score: 'high' },
  ])('rejects malformed search results %j', async (item) => {
    const ctx = await boot({ 'web-search': { provider: 'custom' }, 'web-search-custom': {
      endpoint: 'https://custom.test/search', auth: 'none', scoreField: 'score',
    } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ results: [item] }))
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([null, '{'])('rejects an empty or malformed response body %j', async (body) => {
    const ctx = await boot({ 'web-search': { provider: 'custom' }, 'web-search-custom': {
      endpoint: 'https://custom.test/search', auth: 'none',
    } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([
    [new DOMException('Deadline', 'TimeoutError'), 'TIMEOUT'],
    [new Error('User cancelled'), 'WEB_ABORTED'],
  ] as const)('preserves cancellation reason %s', async (reason, code) => {
    const config = http.CustomConfig({ endpoint: 'https://custom.test/search', auth: 'none' })
    const provider = new http.HttpSearchProvider({
      id: 'custom', displayName: 'Other', configurable: true, settingsNs: customNs, credentialRef: 'KEY', fields: [],
      capabilities: { web: true, images: false, news: false, videos: false, academic: false },
    }, () => config, async () => undefined)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(reason)
    await expect(provider.search({ query: 'q' }, AbortSignal.abort(reason))).rejects.toMatchObject({ code })
  })

  it('rejects unconfigured endpoints and unsupported types at direct execution', async () => {
    let config = http.CustomConfig({ auth: 'none' })
    const provider = new http.HttpSearchProvider({
      id: 'custom', displayName: 'Other', configurable: true, settingsNs: customNs, credentialRef: 'KEY', fields: [],
      capabilities: { web: true, images: false, news: false, videos: false, academic: false },
    }, () => config, async () => undefined)
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect(provider.available()).toBe(false)
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    config = http.CustomConfig({ endpoint: 'https://custom.test/search', auth: 'none' })
    expect(provider.available()).toBe(true)
    await expect(provider.search({ query: 'q', type: 'news' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['POST', 'GET'] as const)('maps %s requests and nested results without passing raw fields', async (method) => {
    const ctx = await boot({ 'web-search': { provider: 'custom' } })
    await ctx.settings.update(customNs, { endpoint: 'https://custom.test/search', auth: 'none', method, queryField: 'query', limitField: 'limit',
      resultsPath: 'data.items', titleField: 'name', urlField: 'href', snippetField: 'description', scoreField: 'score' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ data: { items: [
      { name: 'Docs', href: 'https://example.com/?utm_source=search#ref', description: 'text', score: .7, raw: 'private' },
      { name: 'Duplicate', href: 'https://example.com/' },
    ] } }))
    const result = await ctx.web.search({ query: 'hello world', maxResults: 3 })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({ title: 'Docs', snippet: 'text', score: .7, provider: 'custom' })
    expect(JSON.stringify(result)).not.toContain('private')
    const [url, init] = fetch.mock.calls[0]!
    if (method === 'POST') expect(JSON.parse(init?.body as string)).toEqual({ query: 'hello world', limit: 3 })
    else expect(new URL(url instanceof Request ? url.url : url).searchParams.get('query')).toBe('hello world')
    expect(new Headers(init?.headers).has('X-API-KEY')).toBe(false)
    expect(init?.redirect).toBe('error')
  })

  it.each(['bearer', 'api_key_header', 'custom_header'] as const)('resolves %s credentials and prevents response echoes', async (auth) => {
    vi.stubEnv('CUSTOM_SEARCH_API_KEY', 'credential-never-rendered')
    const ctx = await boot({ 'web-search': { provider: 'custom' } })
    await ctx.settings.update(customNs, { endpoint: 'https://custom.test/search', auth })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ results: [{ url: 'https://example.com/', snippet: 'credential-never-rendered' }] }))
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.get(auth === 'bearer' ? 'Authorization' : 'X-API-KEY')).toBe(auth === 'bearer' ? 'Bearer credential-never-rendered' : 'credential-never-rendered')
  })

  it.each([[401, 'AUTH_ERROR'], [403, 'AUTH_ERROR'], [429, 'RATE_LIMITED'], [502, 'NETWORK_ERROR']] as const)('normalizes HTTP %s and never exposes upstream error text', async (status, code) => {
    const ctx = await boot({ 'web-search': { provider: 'custom' }, 'web-search-custom': { endpoint: 'https://custom.test/search', auth: 'none' } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ error: 'upstream-secret' }, status))
    const error = await ctx.web.testSearchProvider('custom').catch((error: unknown) => error)
    expect(error).toMatchObject({ code, statusCode: status })
    expect(error instanceof Error ? error.message : JSON.stringify(error)).not.toContain('upstream-secret')
  })

  it('rejects wrong mappings, prototype paths, and secrets in request settings', async () => {
    const ctx = await boot({ 'web-search': { provider: 'custom' }, 'web-search-custom': { endpoint: 'https://custom.test/search', auth: 'none' } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ other: [] }))
    await expect(ctx.web.testSearchProvider('custom')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    for (const patch of [{ resultsPath: '__proto__.items' }, { queryField: 'a[0]' }, { staticBody: '{"api_key":"secret"}' }, { endpoint: 'https://user:pass@example.com' }]) {
      await expect(ctx.settings.update(customNs, patch)).rejects.toThrow()
    }
  })

  it('reports timeout and missing credentials without falling back', async () => {
    vi.stubEnv('SERPER_API_KEY', '')
    const ctx = await boot({ 'web-search': { provider: 'serper', timeoutMs: 10 } })
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    await ctx.settings.update(customNs, { endpoint: 'https://custom.test/search', auth: 'none' })
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    }))
    await expect(ctx.web.testSearchProvider('custom')).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
  })

  it('normalizes tracking and fragments while preserving meaningful URL differences', () => {
    expect(normalizedSearchUrl('https://EXAMPLE.com?utm_source=a#b')).toBe('https://example.com/')
    expect(normalizedSearchUrl('https://example.com/?page=2')).not.toBe(normalizedSearchUrl('https://example.com/'))
    expect(normalizedSearchUrl('https://example.com/docs/')).not.toBe(normalizedSearchUrl('https://example.com/docs'))
  })

  it('bounds an uncooperative credential lookup and never dispatches after timeout', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    let resolve!: (value: string) => void
    const key = new Promise<string>((done) => { resolve = done })
    const provider = new http.HttpSearchProvider({
      id: 'custom', displayName: 'Other', configurable: true, settingsNs: customNs, credentialRef: 'KEY', fields: [],
      capabilities: { web: true, images: false, news: false, videos: false, academic: false },
    }, () => http.CustomConfig({ endpoint: 'https://custom.test', timeoutMs: 10 }), () => key)
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'TIMEOUT' })
    resolve('late-secret')
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects oversized JSON before parsing and accepts the exact byte limit', async () => {
    const ctx = await boot({ 'web-search': { provider: 'custom' } })
    const payload = JSON.stringify({ results: [{ url: 'https://example.com', title: 'Tiếng Việt' }] })
    const size = Buffer.byteLength(payload)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(payload))
    await ctx.settings.update(customNs, { endpoint: 'https://custom.test/search', auth: 'none', maxResponseBytes: size })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ title: 'Tiếng Việt' }] })
    await ctx.settings.update(customNs, { maxResponseBytes: size - 1 })
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([301, 302, 303, 307, 308])('rejects real HTTP %i before contacting the redirect target', async (status) => {
    let targetRequests = 0
    const target = createServer((request, response) => { request.resume(); targetRequests++; response.end('{}') })
    const redirect = createServer((request, response) => {
      request.resume()
      response.writeHead(status, { Location: targetUrl }).end()
    })
    const listen = async (server: Server) => {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Search server is not listening')
      return `http://127.0.0.1:${address.port}`
    }
    const targetUrl = await listen(target)
    const endpoint = await listen(redirect)
    try {
      vi.stubEnv('CUSTOM_SEARCH_API_KEY', 'redirect-secret')
      const ctx = await boot({ 'web-search': { provider: 'custom' }, 'web-search-custom': { endpoint } })
      await expect(ctx.web.search({ query: 'private query' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
      expect(targetRequests).toBe(0)
    } finally {
      await Promise.all([target, redirect].map(server => new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })))
    }
  })
})
