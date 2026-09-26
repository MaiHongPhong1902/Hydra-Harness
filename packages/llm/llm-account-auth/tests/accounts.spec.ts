import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { Context } from '@hydra/cordis'
import { CredentialProvider, credentialKey } from '@hydra/harness-credentials'
import type { Credential } from '@earendil-works/pi-ai'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@hydra/harness-credentials'
import { createAccountPool, emptyAuthContext, parseAccountPool } from '../src/accounts.ts'
import { readAccountUsage } from '../src/usage.ts'
import type { StreamChunk } from '@hydra/harness-llm'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve(record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next !== undefined) this.records.set(key, next)
    return next ?? current
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

async function fixture(provider: 'chatgpt' | 'antigravity' = 'chatgpt'): Promise<{ ctx: Context; pool: ReturnType<typeof createAccountPool> }> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  return {
    ctx,
    pool: createAccountPool({
      ctx,
      key: credentialKey('llm-account-auth', provider),
      providerId: provider,
      providerLabel: provider === 'chatgpt' ? 'ChatGPT' : 'Antigravity',
    }),
  }
}

describe('account pools', () => {
  it('has no ambient credential access and fails without a credentials provider', async () => {
    await expect(emptyAuthContext.env('TOKEN')).resolves.toBeUndefined()
    await expect(emptyAuthContext.fileExists('file')).resolves.toBe(false)
    const pool = createAccountPool({ ctx: new Context(), key: credentialKey('test', 'test'), providerId: 'test', providerLabel: 'Test' })
    await expect(pool.accounts.list()).rejects.toMatchObject({ code: 'NO_CREDENTIAL_STORE' })
  })

  it('rejects a credential provider that never invokes its write callback', async () => {
    const { ctx, pool } = await fixture()
    try {
      vi.spyOn(ctx.credentials, 'modifyRecord').mockResolvedValue(undefined)
      await expect(pool.add(undefined, { type: 'api_key', key: 'key' })).rejects.toThrow('did not commit')
    } finally { await ctx.fiber.dispose() }
  })

  it('isolates unknown providers, unselected reads, refreshes, and selected deletions', async () => {
    const { ctx, pool } = await fixture()
    try {
      await expect(pool.selector.ordered('other')).resolves.toEqual([])
      await expect(pool.selector.ordered('chatgpt')).resolves.toEqual([])
      await expect(pool.credentials.list()).resolves.toEqual([])
      await expect(pool.credentials.read('other')).resolves.toBeUndefined()
      const key = { type: 'api_key', key: 'secret', accountId: 'first' } as const
      await expect(pool.credentials.modify('other', async current => current)).resolves.toBeUndefined()
      await pool.withLoginLabel(' First ', () => pool.credentials.modify('chatgpt', async () => key))
      const first = (await pool.accounts.list())[0]!
      await expect(pool.credentials.list()).resolves.toEqual([{ providerId: 'chatgpt', type: 'api_key' }])
      await expect(pool.credentials.read('chatgpt')).resolves.toBeUndefined()
      await pool.credentials.modify('chatgpt', async () => ({ ...key, key: 'replaced' }))
      await pool.credentials.modify('chatgpt', async () => ({ type: 'api_key', key: 'generated' }))
      await pool.credentials.modify('chatgpt', async () => ({ ...key, key: 'duplicate' }))
      await pool.withAccount(first.id, async () => {
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ key: 'duplicate' })
        await expect(pool.credentials.modify('chatgpt', async () => undefined)).resolves.toBeUndefined()
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ key: 'duplicate' })
      })
      await pool.add(undefined, { ...key, accountId: 'second' } as Credential & Record<string, unknown>)
      await pool.withAccount(first.id, () => pool.credentials.modify('chatgpt', async () => ({ ...key, key: 'refreshed' })))
      await pool.credentials.delete('other')
      expect(await pool.accounts.list()).toHaveLength(3)
      await pool.withAccount(first.id, () => pool.credentials.delete('chatgpt'))
      expect(await pool.accounts.list()).toHaveLength(2)
      await expect(pool.accounts.remove(first.id)).rejects.toMatchObject({ code: 'ACCOUNT_GONE' })
      await pool.credentials.delete('chatgpt')
      expect(await pool.accounts.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps account selection active through stream iteration and early cleanup', async () => {
    const { ctx, pool } = await fixture()
    try {
      const first = await pool.add('First', { type: 'api_key', key: 'first' })
      const reads: unknown[] = []
      const source = async function* (): AsyncIterable<StreamChunk> {
        try {
          reads.push(await pool.credentials.read('chatgpt'))
          yield { type: 'text', text: 'first' } as unknown as StreamChunk
          reads.push(await pool.credentials.read('chatgpt'))
        } finally { reads.push(await pool.credentials.read('chatgpt')) }
      }
      for await (const _chunk of pool.selector.stream('chatgpt', first.id, source)) { /* consume to completion */ }
      expect(reads).toEqual(Array.from({ length: 3 }, () => ({ type: 'api_key', key: 'first' })))
      reads.length = 0
      for await (const _chunk of pool.selector.stream('chatgpt', first.id, source)) break
      expect(reads).toEqual(Array.from({ length: 2 }, () => ({ type: 'api_key', key: 'first' })))
      const iterator = pool.selector.stream('other', first.id, source)[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toMatchObject({ code: 'ACCOUNT_PROVIDER' })
      const cleanupFailure = async function* (): AsyncIterable<StreamChunk> {
        try { yield { type: 'text', text: 'first' } as unknown as StreamChunk }
        finally { throw new Error('cleanup failed') }
      }
      for await (const _chunk of pool.selector.stream('chatgpt', first.id, cleanupFailure)) break
      const noReturn: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: { type: 'text', text: 'first' } as unknown as StreamChunk }) }),
      }
      for await (const _chunk of pool.selector.stream('chatgpt', first.id, () => noReturn)) break
      await expect(pool.credentials.read('chatgpt')).resolves.toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    [{ workspaceId: 'workspace', userId: 'user' }, 'workspace:user'],
    [{ workspaceId: 'workspace' }, 'workspace'],
    [{ userId: 'user' }, 'user'],
    [{ emailAddress: 'user@example.test' }, 'user@example.test'],
    [{ id: 'id' }, 'id'],
  ])('uses credential identity fields %j', async (fields, identity) => {
    const { ctx, pool } = await fixture()
    try {
      await expect(pool.add(undefined, { type: 'api_key', key: 'key', ...fields }))
        .resolves.toMatchObject({ id: identity })
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    [{ email: 'token@example.test', sub: 'user' }, 'token@example.test'],
    [{ userId: 'user' }, 'user'],
    [{ 'https://api.openai.com/auth': { email: 'auth@example.test' } }, 'auth@example.test'],
    [{ 'https://api.openai.com/auth': { userId: 'auth-user' } }, 'auth-user'],
    [{ 'https://api.openai.com/profile': { name: 'Profile name' } }, 'Profile name'],
  ])('uses token labels and identities %j without browser globals', async (claims, label) => {
    const { ctx, pool } = await fixture()
    try {
      vi.stubGlobal('atob', undefined)
      const access = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
      await expect(pool.add(undefined, { type: 'oauth', access, refresh: 'refresh', expires: 1 })).resolves.toMatchObject({ label })
    } finally { await ctx.fiber.dispose() }
  })

  it('ignores malformed access-token claims when deriving a display label', async () => {
    const { ctx, pool } = await fixture()
    try {
      await expect(pool.add(undefined, { type: 'oauth', access: 'header.invalid.signature', refresh: 'refresh', expires: 1 }))
        .resolves.toMatchObject({ label: 'ChatGPT account 1' })
    } finally { await ctx.fiber.dispose() }
  })

  it('derives labels from provider identity when no label is supplied', async () => {
    const { ctx, pool } = await fixture()
    try {
      const email = await pool.add(undefined, {
        type: 'oauth', access: 'access-email', refresh: 'refresh-email', expires: 1,
        email: 'user@example.test',
      })
      const payload = Buffer.from(JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'account-from-claim' },
      })).toString('base64url')
      const claim = await pool.add(undefined, {
        type: 'oauth', access: `header.${payload}.signature`, refresh: 'refresh-claim', expires: 1,
      })
      const fallback = await pool.add(undefined, {
        type: 'oauth', access: 'access-fallback', refresh: 'refresh-fallback', expires: 1,
      })
      expect([email.label, claim.label, fallback.label]).toEqual([
        'user@example.test', 'account-from-claim', 'ChatGPT account 3',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('persists labels, isolates account reads, and rotates selection', async () => {
    const { ctx, pool } = await fixture()
    try {
      const first = await pool.add(' first ', {
        type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 1,
      })
      const second = await pool.add('second', {
        type: 'oauth', access: 'access-2', refresh: 'refresh-2', expires: 2,
      })
      expect(await pool.accounts.list()).toEqual([
        { id: first.id, label: 'first' },
        { id: second.id, label: 'second' },
      ])
      await pool.withAccount(first.id, async () => {
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ access: 'access-1' })
      })
      await pool.withAccount(second.id, async () => {
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ access: 'access-2' })
      })
      await expect(pool.selector.ordered('chatgpt')).resolves.toEqual([{ id: first.id }, { id: second.id }])
      await expect(pool.selector.ordered('chatgpt')).resolves.toEqual([{ id: second.id }, { id: first.id }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('checks cancellation inside the serialized add mutation', async () => {
    const { ctx, pool } = await fixture()
    try {
      const controller = new AbortController()
      controller.abort('cancelled')
      await expect(pool.add('cancelled', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: 1,
      }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
      await expect(pool.accounts.list()).resolves.toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('normalizes the official ChatGPT windows and banked reset credits', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = await pool.add('ChatGPT', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        accountId: 'account-1',
      })
      const requests: Array<{ url: string; init?: RequestInit }> = []
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        requests.push({ url, ...(init === undefined ? {} : { init }) })
        return new Response(JSON.stringify(url.endsWith('/usage')
          ? { plan_type: 'plus', rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
            secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
          } } : { available_count: 2 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }))
      const usage = await readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)
      expect(usage.planType).toBe('plus')
      expect(usage.limits.map(limit => [limit.name, limit.windowMinutes, limit.usedPercent])).toEqual([
        ['Codex', 300, 25], ['Codex', 10_080, 50],
      ])
      expect(usage.bankedResetCount).toBe(2)
      expect(requests.map(request => request.url)).toEqual([
        'https://chatgpt.com/backend-api/wham/usage',
        'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      ])
      expect(requests[0]?.init?.headers).toMatchObject({
        accept: 'application/json', authorization: 'Bearer access', 'chatgpt-account-id': 'account-1',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps usage when the optional banked reset endpoint is unavailable', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = await pool.add('ChatGPT', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        accountId: 'account-2',
      })
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return url.endsWith('/usage')
          ? Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 0 } } })
          : new Response('missing', { status: 404 })
      }))
      const usage = await readAccountUsage(pool, account.id, 'chatgpt', {}, 5_000)
      expect(usage.limits).toEqual([{ name: 'Codex', usedPercent: 0 }])
      expect(usage.bankedResetCount).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads Antigravity quota and tier through the configured endpoint', async () => {
    const { ctx, pool } = await fixture('antigravity')
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(String(chunk))))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        if (request.url === '/v1internal:fetchAvailableModels') {
          expect(request.method).toBe('POST')
          expect(request.headers.authorization).toBe('Bearer access')
          expect(JSON.parse(body)).toEqual({ project: 'project-1' })
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ models: {
            gemini: { displayName: 'Gemini', quotaInfo: { remainingFraction: 0.75, resetTime: '2026-09-27T00:00:00Z' } },
            internal: { isInternal: true, quotaInfo: { remainingFraction: 0.1 } },
          } }))
          return
        }
        expect(request.url).toBe('/v1internal:loadCodeAssist')
        expect(request.method).toBe('POST')
        expect(request.headers.authorization).toBe('Bearer access')
        expect(JSON.parse(body)).toMatchObject({ cloudaicompanionProject: 'project-1' })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ paidTier: { name: 'Pro' } }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not expose a port')
      const account = await pool.add('Antigravity', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
        projectId: 'project-1',
      })
      const usage = await readAccountUsage(pool, account.id, 'antigravity', {
        endpoint: `http://127.0.0.1:${address.port}`,
      }, 5_000)
      expect(usage.planType).toBe('Pro')
      expect(usage.limits).toEqual([{
        name: 'Gemini', usedPercent: 25, resetsAt: Math.floor(Date.parse('2026-09-27T00:00:00Z') / 1000),
      }])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
      await ctx.fiber.dispose()
    }
  })

  it('reports unavailable Antigravity quotas and rejects invalid fractions', async () => {
    const read = async (models: Record<string, unknown>) => {
      const { ctx, pool } = await fixture('antigravity')
      const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(request.url?.endsWith(':fetchAvailableModels')
            ? { models } : {}))
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      try {
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('test server did not expose a port')
        const account = await pool.add('Antigravity', {
          type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000,
          projectId: 'project-2',
        })
        return await readAccountUsage(pool, account.id, 'antigravity', {
          endpoint: `http://127.0.0.1:${address.port}`,
        }, 5_000)
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        }))
        await ctx.fiber.dispose()
      }
    }
    const unavailable = await read({ gemini: { displayName: 'Gemini' } })
    expect(unavailable.limits).toEqual([])
    expect(unavailable.planType).toBeUndefined()
    await expect(read({ gemini: { quotaInfo: { remainingFraction: 2 } } })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('hashes oversized combined token identities without collapsing users', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = 'a'.repeat(200)
      const firstUser = 'u'.repeat(200)
      const secondUser = 'v'.repeat(200)
      const grant = (userId: string) => ({
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: 1,
        accountId: account,
        userId,
      }) as Credential & Record<string, unknown>
      const added = await pool.add('first identity', grant(firstUser))
      const second = await pool.add('second identity', grant(secondUser))
      const relogged = await pool.add('first identity updated', grant(firstUser))
      expect(added.id).not.toBe(account)
      expect(added.id).not.toBe(second.id)
      expect(added.id).toBe(relogged.id)
      expect(added.id.length).toBeLessThanOrEqual(256)
      await expect(pool.accounts.list()).resolves.toEqual([
        { id: added.id, label: 'first identity updated' },
        { id: second.id, label: 'second identity' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('stored account pool validation', () => {
  const valid = { id: 'account', label: 'Account', credential: { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1 } }
  const record = (accounts: unknown): CredentialRecord => ({ kind: 'grant', payload: { version: 1, accounts } })

  it.each([undefined, null, [], 'entry', { ...valid, id: '' }, { ...valid, id: 'x'.repeat(257) },
    { ...valid, label: '' }, { ...valid, label: 'x'.repeat(513) },
  ])('rejects a malformed persisted account: %j', (entry) => {
    expect(() => parseAccountPool(record([entry]))).toThrow('invalid account entry')
  })

  it.each([undefined, null, [], {}, { type: 'other' },
    { ...valid.credential, access: '' }, { ...valid.credential, access: 1 },
    { ...valid.credential, refresh: '' }, { ...valid.credential, refresh: 1 },
    { ...valid.credential, expires: '1' }, { ...valid.credential, expires: Infinity },
    { type: 'api_key', key: '' }, { type: 'api_key', key: 1 },
    { type: 'api_key', env: [] }, { type: 'api_key', env: { KEY: 1 } },
  ])('rejects malformed stored credentials: %j', (credential) => {
    expect(() => parseAccountPool(record([{ ...valid, credential }]))).toThrow('invalid account entry')
  })

  it('rejects invalid envelopes, duplicate identities, and non-cloneable credentials', () => {
    expect(() => parseAccountPool({ kind: 'secret', value: 'key' } as never)).toThrow('grant record')
    for (const payload of [null, [], { version: 2, accounts: [] }, { version: 1, accounts: {} }]) {
      expect(() => parseAccountPool({ kind: 'grant', payload })).toThrow('invalid account-pool payload')
    }
    expect(() => parseAccountPool(record([valid, valid]))).toThrow('duplicate account ids')
    expect(() => parseAccountPool(record([{ ...valid, credential: { ...valid.credential, callback() {} } }])))
      .toThrow('invalid account entry')
  })

  it('accepts OAuth and environment-backed credentials and detaches stored data', () => {
    const input = record([valid, { ...valid, id: 'api', credential: { type: 'api_key', env: { KEY: 'value' } } }])
    const parsed = parseAccountPool(input)
    expect(parsed.accounts).toHaveLength(2)
    expect(parsed.accounts[0]?.credential).toEqual(valid.credential)
    expect(parsed.accounts[0]?.credential).not.toBe(valid.credential)
  })
})
