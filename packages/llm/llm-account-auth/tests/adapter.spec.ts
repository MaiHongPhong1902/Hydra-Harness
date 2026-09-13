import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import { credentialKey } from '@hydra/harness-credentials'
import { LlmError } from '@hydra/harness-llm'
import type { AccountPool } from '../src/accounts.ts'
import { AntigravityAccountAdapter } from '../src/adapter.ts'
import { ANTIGRAVITY_TOKEN_ENDPOINT } from '../src/antigravity-oauth.ts'
import type { GenerateOptions, StreamChunk } from '@hydra/harness-llm'

interface TestAccount {
  readonly id: string
  credential: Credential
}

interface TestPoolOptions {
  readonly accounts: TestAccount[]
  readonly order?: () => readonly string[]
  readonly stream?: (
    accountId: string,
    source: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function accountPool(options: TestPoolOptions): AccountPool {
  let selected: string | undefined
  const records = new Map(options.accounts.map(account => [account.id, account]))
  const order = options.order ?? (() => options.accounts.map(account => account.id))
  const selector = {
    ordered: vi.fn(async () => order().map(id => ({ id }))),
    stream: async function* (
      _provider: string,
      accountId: string,
      source: () => AsyncIterable<StreamChunk>,
    ): AsyncIterable<StreamChunk> {
      if (options.stream !== undefined) {
        yield* options.stream(accountId, source)
        return
      }
      yield* source()
    },
  }
  const credentials = {
    async read(provider: string): Promise<Credential | undefined> {
      return provider === 'antigravity' ? records.get(selected ?? '')?.credential : undefined
    },
    async list() { return [] },
    async modify(provider: string, callback: (current: Credential | undefined) => Promise<Credential | undefined>) {
      if (provider !== 'antigravity') return callback(undefined)
      const account = records.get(selected ?? '')
      const next = await callback(account?.credential)
      if (next !== undefined && account !== undefined) account.credential = next
      return next ?? account?.credential
    },
    async delete() { return undefined },
  }
  return {
    key: credentialKey('llm-account-auth', 'antigravity'),
    credentials,
    accounts: {
      list: async () => options.accounts.map(({ id }) => ({ id: id as never, label: id })),
      remove: async () => undefined,
    },
    selector,
    add: async () => ({ id: 'unused' as never, label: 'unused' }),
    withLoginLabel: async (_label, operation) => operation(),
    withAccount: async (id, operation) => {
      const previous = selected
      selected = String(id)
      try {
        return await operation()
      } finally {
        selected = previous
      }
    },
  }
}

function credentials(access: string, expires = Date.now() + 60_000): Credential {
  return {
    type: 'oauth',
    access,
    refresh: `refresh-${access}`,
    expires,
    projectId: 'project-fixture',
  }
}

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-test',
    messages: [{
      id: 'message-1' as never,
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }],
    ...extra,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('account-backed Antigravity adapter', () => {
  it('refreshes one expired account, preserves siblings, and caches its catalog', async () => {
    const first: TestAccount = { id: 'first', credential: credentials('old-access', 0) }
    const sibling: TestAccount = { id: 'sibling', credential: credentials('sibling-access') }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input)
      if (url === ANTIGRAVITY_TOKEN_ENDPOINT) {
        return Response.json({ access_token: 'new-access', expires_in: 3600 })
      }
      expect(url).toBe('https://fixture.test/v1internal:fetchAvailableModels')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer new-access' })
      return Response.json({ models: {
        gemini: { displayName: 'Gemini', maxTokens: 8192, maxOutputTokens: 1024, supportsImages: true },
        internal: { isInternal: true },
      } })
    })
    const pool = accountPool({ accounts: [first, sibling] })
    const profile = { endpoint: 'https://fixture.test' }
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => profile })

    await expect(adapter.discoverModels()).resolves.toEqual([{
      id: 'gemini', name: 'Gemini', contextWindow: 8192, maxTokens: 1024,
    }])
    await expect(adapter.listModels('antigravity')).resolves.toEqual([{
      provider: 'antigravity', id: 'gemini', name: 'Gemini', inputModalities: ['text', 'image'],
    }])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(first.credential).toMatchObject({ access: 'new-access' })
    expect(sibling.credential).toMatchObject({ access: 'sibling-access' })
  })

  it('invalidates discovery when the profile or selected account changes', async () => {
    const first: TestAccount = { id: 'first', credential: credentials('first-access') }
    const second: TestAccount = { id: 'second', credential: credentials('second-access') }
    let profile = { endpoint: 'https://one.test' }
    let selected = ['first']
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input)
      return Response.json({ models: { [url.includes('one.test') ? 'one' : 'two']: {} } })
    })
    const adapter = new AntigravityAccountAdapter({
      pool: accountPool({ accounts: [first, second], order: () => selected }),
      profile: () => profile,
    })

    await expect(adapter.discoverModels()).resolves.toMatchObject([{ id: 'one' }])
    selected = ['second']
    profile = { endpoint: 'https://two.test' }
    await expect(adapter.discoverModels()).resolves.toMatchObject([{ id: 'two' }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('fails over before visible output and strips replay state on every account request', async () => {
    const first: TestAccount = { id: 'first', credential: credentials('first-access') }
    const second: TestAccount = { id: 'second', credential: credentials('second-access') }
    const seenContents: unknown[] = []
    const pool = accountPool({
      accounts: [first, second],
      stream: async function* (accountId, source) {
        if (accountId === 'first') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'first failed' } } }
          return
        }
        yield* source()
      },
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as { request?: { contents?: unknown } }
      seenContents.push(body.request?.contents)
      return new Response([
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } })}`,
        `data: ${JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } })}`,
        '',
      ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const replaying = request({ messages: [{
      id: 'assistant-1' as never,
      role: 'assistant',
      content: [{ type: 'text', text: 'prior' }],
      source: {
        kind: 'model',
        provider: 'antigravity',
        model: 'gemini-test',
        replayState: { response: { responseId: 'prior' }, blocks: [{ thoughtSignature: 'AQ==' }] },
      },
    }] })
    const chunks: StreamChunk[] = []
    for await (const chunk of new AntigravityAccountAdapter({
      pool,
      profile: () => ({ endpoint: 'https://fixture.test' }),
    }).stream(replaying)) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(seenContents[0])).not.toContain('thoughtSignature')
  })

  it('drops the prior account replay state when the next request rotates accounts', async () => {
    const first: TestAccount = { id: 'first', credential: credentials('first-access') }
    const second: TestAccount = { id: 'second', credential: credentials('second-access') }
    let requestNumber = 0
    const seen: Array<{ authorization: string; body: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seen.push({
        authorization: new Headers(init?.headers).get('Authorization') ?? '',
        body: typeof init?.body === 'string' ? init.body : '',
      })
      return new Response([
        `data: ${JSON.stringify({ response: { responseId: 'response', candidates: [{ content: { parts: [{ text: 'ok', thoughtSignature: 'AQ==' }] } }] } })}`,
        `data: ${JSON.stringify({ response: { candidates: [{ finishReason: 'STOP' }] } })}`,
        '',
      ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const pool = accountPool({
      accounts: [first, second],
      order: () => [requestNumber++ === 0 ? 'first' : 'second'],
    })
    const adapter = new AntigravityAccountAdapter({
      pool,
      profile: () => ({ endpoint: 'https://fixture.test' }),
    })
    const firstChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(request())) firstChunks.push(chunk)
    const finish = firstChunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
    if (finish?.replayState === undefined) throw new Error('fixture response did not produce replay state')
    const secondChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(request({ messages: [{
      id: 'assistant-1' as never,
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', provider: 'antigravity', model: 'gemini-test', replayState: finish.replayState },
    }] }))) secondChunks.push(chunk)
    expect(secondChunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.authorization).toBe('Bearer first-access')
    expect(seen[1]?.authorization).toBe('Bearer second-access')
    expect(seen[1]?.body).not.toContain('thoughtSignature')
  })

  it('does not commit a refresh that completes after cancellation', async () => {
    const first: TestAccount = { id: 'first', credential: credentials('old-access', 0) }
    const controller = new AbortController()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(requestUrl(input)).toBe(ANTIGRAVITY_TOKEN_ENDPOINT)
      controller.abort('cancelled after token response')
      return Response.json({ access_token: 'new-access', expires_in: 3600 })
    })
    const pool = accountPool({ accounts: [first] })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
    await expect(async () => {
      for await (const _chunk of adapter.stream(request({ signal: controller.signal }))) { /* cancellation is terminal */ }
    }).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(first.credential).toMatchObject({ access: 'old-access' })
  })

  it('treats an ABORTED account error as terminal without trying a sibling', async () => {
    const orderCalls = { count: 0 }
    const pool = accountPool({
      accounts: [
        { id: 'first', credential: credentials('first-access') },
        { id: 'second', credential: credentials('second-access') },
      ],
      order: () => {
        orderCalls.count += 1
        return ['first', 'second']
      },
      stream: async function* () {
        throw new LlmError('cancelled', 'ABORTED')
      },
    })
    const adapter = new AntigravityAccountAdapter({ pool, profile: () => ({}) })
    await expect(async () => {
      for await (const _chunk of adapter.stream(request())) { /* terminal error */ }
    }).rejects.toMatchObject({ code: 'ABORTED' })
    expect(orderCalls.count).toBe(1)
  })
})
