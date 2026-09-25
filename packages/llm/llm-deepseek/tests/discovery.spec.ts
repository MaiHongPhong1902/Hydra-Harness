/** Model discovery through the registered provider and its HTTP endpoint. */
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import LlmRuntime from '@hydra/harness-llm'
import { fetchWithHttpProxy } from '@hydra/harness-llm/proxy'
import * as DeepSeek from '../src/index.ts'
import { discoverDeepSeekModels } from '../src/adapter.ts'

vi.mock('@hydra/harness-llm/proxy', async importOriginal => ({
  ...await importOriginal<typeof import('@hydra/harness-llm/proxy')>(),
  fetchWithHttpProxy: vi.fn((url: string, init: RequestInit) => fetch(url, init)),
}))

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.mocked(fetchWithHttpProxy).mockClear()
})

async function listing(body: string, status = 200) {
  const requests: Array<{ path: string | undefined; headers: IncomingHttpHeaders }> = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers })
    response.writeHead(status, { 'content-type': 'application/json' }).end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve()
    else reject(error)
  })))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP server')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

it('uses saved credentials and connection defaults, with per-probe overrides', async () => {
  const saved = await listing('{"data":[{"id":"saved"}]}')
  const draft = await listing('{"data":[{"id":"draft","name":"Draft model"}]}')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('credentials', { resolve: async () => ({ value: 'saved-key' }) } as never)
  await ctx.plugin(LlmRuntime)
  const provider = ctx.plugin(DeepSeek, { baseURL: saved.url })
  await provider
  expect(await ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' })).toEqual([{ id: 'saved' }])
  expect(saved.requests).toMatchObject([{ path: '/models', headers: { authorization: 'Bearer saved-key' } }])
  const signal = new AbortController().signal
  expect(await ctx.llm.discoverModels('llm-deepseek', { baseURL: draft.url, apiKey: 'draft-key', proxy: 'http://127.0.0.1:8080', signal }))
    .toEqual([{ id: 'draft', name: 'Draft model' }])
  expect(vi.mocked(fetchWithHttpProxy).mock.calls.at(-1)).toMatchObject([
    `${draft.url}/models`, { signal, headers: { authorization: 'Bearer draft-key' } }, 'http://127.0.0.1:8080',
  ])
  await provider.dispose()
  await ctx.plugin(DeepSeek, { baseURL: saved.url, proxy: 'http://127.0.0.1:9090' })
  await ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' })
  expect(vi.mocked(fetchWithHttpProxy).mock.calls.at(-1)?.[2]).toBe('http://127.0.0.1:9090')
})

it('keeps distinct valid model ids and ignores malformed or duplicate rows', async () => {
  const server = await listing(JSON.stringify({ data: [null, [], 'model', {}, { id: '' }, { id: 1 },
    { id: 'one', name: 'One' }, { id: 'one', name: 'Duplicate' }, { id: 'two', name: '' }, { id: 'three', name: 5 }] }))
  expect(await discoverDeepSeekModels({ baseURL: `${server.url}///`, apiKey: 'key' }))
    .toEqual([{ id: 'one', name: 'One' }, { id: 'two' }, { id: 'three' }])
})

it.each([
  [{}, 'INVALID_DISCOVERY'], [{ baseURL: ' ' }, 'INVALID_DISCOVERY'],
  [{ baseURL: 'http://unused.test' }, 'INVALID_CREDENTIAL'], [{ baseURL: 'http://unused.test', apiKey: ' ' }, 'INVALID_CREDENTIAL'],
] as const)('rejects missing discovery inputs: %j', async (request, code) => {
  await expect(discoverDeepSeekModels(request)).rejects.toMatchObject({ code })
})

it.each([[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'SERVER'], [400, 'INVALID_REQUEST']] as const)(
  'classifies HTTP %s', async (status, code) => {
    const server = await listing('private provider details', status)
    await expect(discoverDeepSeekModels({ baseURL: server.url, apiKey: 'key' })).rejects.toMatchObject({ code, failure: { status } })
  },
)

it.each(['not json', 'null', '[]', '"text"', '{}', '{"data":null}'])('rejects malformed model list %s', async (body) => {
  const server = await listing(body)
  await expect(discoverDeepSeekModels({ baseURL: server.url, apiKey: 'key' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
})

it('distinguishes cancellation from an unavailable endpoint', async () => {
  await expect(discoverDeepSeekModels({ baseURL: 'http://127.0.0.1:1', apiKey: 'key' })).rejects.toMatchObject({ code: 'TRANSPORT' })
  await expect(discoverDeepSeekModels({ baseURL: 'http://127.0.0.1:1', apiKey: 'key', signal: AbortSignal.abort() }))
    .rejects.toMatchObject({ code: 'ABORTED' })
})
