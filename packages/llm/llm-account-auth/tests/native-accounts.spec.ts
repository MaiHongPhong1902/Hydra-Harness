/** Native subscription authentication, durable refresh, and account-bound catalogs. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import { LocalCredentialProvider } from '@hydraharness/harness-credentials-local'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import type { AuthorizationNotice } from '@hydraharness/harness-authorization'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import { accountRecordKey, createAccountPool } from '../src/accounts.ts'
import { loginCursor, loginKiro, refreshNativeAccount } from '../src/native-login.ts'
import { accountJson } from '../src/json-response.ts'
import { nativeCredential } from '../src/kiro.ts'
import { readAccountUsage } from '../src/usage.ts'
import { ACCOUNT_PROVIDER_LABELS, resolveProfiles, type AccountProvider } from '../src/config.ts'

const contexts: Context[] = []
const tempDirectories: string[] = []
const polling = vi.hoisted(() => vi.fn(async (_ms: number, _value: undefined, options: { signal: AbortSignal }) => {
  options.signal.throwIfAborted()
}))
vi.mock('node:timers/promises', () => ({ setTimeout: polling }))
afterEach(async () => {
  polling.mockClear()
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of tempDirectories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function poolFor(provider: AccountProvider) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  return createAccountPool({ ctx, key: accountRecordKey(provider), providerId: provider, providerLabel: ACCOUNT_PROVIDER_LABELS[provider] })
}

function session(signal = new AbortController().signal) {
  return { signal, method: 'oauth', notify: vi.fn<(notice: AuthorizationNotice) => void>(), prompt: vi.fn(async () => '') }
}

it('completes Cursor PKCE polling, stores the grant, and exposes no invented usage', async () => {
  const pool = await poolFor('cursor')
  const login = session()
  const requests: string[] = []
  const token = `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000, email: 'cursor@example.test' })).toString('base64url')}.signature`
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    requests.push(input)
    return requests.length === 1 ? new Response(null, { status: 404 }) : Response.json({ accessToken: token, refreshToken: 'cursor-refresh' })
  }))
  await loginCursor(login, pool, { loginPollIntervalMs: 1 })
  const notice = vi.mocked(login.notify).mock.calls[0]![0]
  const browser = new URL(notice.url!)
  const polling = new URL(requests[1]!)
  expect(browser.origin + browser.pathname).toBe('https://cursor.com/loginDeepControl')
  expect(browser.searchParams.get('challenge')).toBe(createHash('sha256').update(polling.searchParams.get('verifier')!).digest('base64url'))
  expect(browser.searchParams.get('uuid')).toBe(polling.searchParams.get('uuid'))
  const [account] = await pool.accounts.list()
  expect(account?.label).toBe('cursor@example.test')
  expect(await pool.withAccount(account!.id, () => pool.credentials.read('cursor'))).toMatchObject({ access: token, refresh: 'cursor-refresh', expires: 2_000_000_000_000 })
  expect(await readAccountUsage(pool, account!.id, 'cursor', {}, 1000)).toBeUndefined()
})

it('cancels Cursor login before a grant can be stored', async () => {
  const pool = await poolFor('cursor')
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => {
    controller.abort(new Error('cancel login'))
    return Response.json({ accessToken: 'access', refreshToken: 'refresh' })
  }))
  await expect(loginCursor(session(controller.signal), pool, { loginPollIntervalMs: 1 })).rejects.toThrow('cancel login')
  expect(await pool.accounts.list()).toEqual([])
})

it('authorizes Kiro using its registered AWS client and retains refresh metadata', async () => {
  const pool = await poolFor('kiro')
  const login = session()
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    calls.push({ url, body })
    if (url.endsWith('/client/register')) return Response.json({ clientId: 'client', clientSecret: 'secret', clientSecretExpiresAt: 2_000_000_000 })
    if (url.endsWith('/device_authorization')) return Response.json({ deviceCode: 'device', userCode: 'ABCD', verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD', interval: 1, expiresIn: 600 })
    if (calls.length === 3) return Response.json({ error: 'authorization_pending' }, { status: 400 })
    if (calls.length === 4) return Response.json({ error: 'slow_down' }, { status: 400 })
    return Response.json({ accessToken: 'kiro-access', refreshToken: 'kiro-refresh', expiresIn: 3600 })
  }))
  await loginKiro(login, pool, {})
  expect(polling.mock.calls.map(call => call[0])).toEqual([1000, 1000, 6000])
  expect(calls[0]!.body).toMatchObject({ clientType: 'public', issuerUrl: 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6' })
  expect(calls[1]!.body).toEqual({ clientId: 'client', clientSecret: 'secret', startUrl: 'https://view.awsapps.com/start' })
  expect(calls[2]!.body).toMatchObject({ grantType: 'urn:ietf:params:oauth:grant-type:device_code', deviceCode: 'device' })
  expect(vi.mocked(login.notify).mock.calls[0]![0].code).toBe('ABCD')
  const [account] = await pool.accounts.list()
  expect(await pool.withAccount(account!.id, () => pool.credentials.read('kiro'))).toMatchObject({ type: 'oauth', clientId: 'client', clientSecret: 'secret', region: 'us-east-1', refresh: 'kiro-refresh' })
})

it.each([0, Infinity, -1, 0.5, 3_000_000])('rejects invalid Kiro device expiry %s before polling or storage', async (expiresIn) => {
  const pool = await poolFor('kiro')
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ clientId: 'client', clientSecret: 'secret' }))
    .mockResolvedValueOnce(Response.json({ deviceCode: 'device', userCode: 'code', verificationUri: 'https://verify.test', expiresIn }))
  vi.stubGlobal('fetch', fetcher)
  await expect(loginKiro(session(), pool, {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await pool.accounts.list()).toEqual([])
})

it('refreshes expired Kiro grants once under concurrent selected-account reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hydra-native-account-'))
  tempDirectories.push(directory)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { hydraHome: directory, watch: false })
  const pool = createAccountPool({ ctx, key: accountRecordKey('kiro'), providerId: 'kiro', providerLabel: 'Kiro' })
  const account = await pool.add(undefined, { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1, clientId: 'client', clientSecret: 'secret', region: 'us-east-1' })
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(JSON.parse(init.body as string)).toEqual({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', grantType: 'refresh_token' })
    return Response.json({ accessToken: 'new', refreshToken: 'rotated', expiresIn: 3600 })
  })
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  const grants = await Promise.all([nativeCredential(pool, 'kiro', account.id, signal), nativeCredential(pool, 'kiro', account.id, signal)])
  expect(grants.map(grant => grant.access)).toEqual(['new', 'new'])
  expect(fetcher).toHaveBeenCalledOnce()
  expect(await pool.withAccount(account.id, () => pool.credentials.read('kiro'))).toMatchObject({ access: 'new', refresh: 'rotated', clientId: 'client' })
})

it('rejects expired client registrations and invalid durable regions without a refresh request', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const current: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1, clientId: 'client', clientSecret: 'secret', region: 'us-east-1' }
  for (const extra of [{ region: 'us-east-1.bad.test/' }, { clientSecretExpiresAt: 1 }]) {
    await expect(refreshNativeAccount('kiro', { ...current, ...extra }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('refreshes Cursor with its refresh token and keeps an omitted rotating refresh token', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer refresh')
    return Response.json({ accessToken: 'updated' })
  })
  vi.stubGlobal('fetch', fetcher)
  const current: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1 }
  const next = await refreshNativeAccount('cursor', current, new AbortController().signal)
  expect(next).toMatchObject({ access: 'updated', refresh: 'refresh' })
  expect(fetcher.mock.calls[0]![0]).toBe('https://api2.cursor.sh/auth/exchange_user_api_key')
})

it('accepts a pending Cursor response and refreshes opaque grants without assuming JWT claims', async () => {
  const pool = await poolFor('cursor')
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ accessToken: 'header.e30.signature', refreshToken: 'refresh' }))
  vi.stubGlobal('fetch', fetcher)
  await loginCursor(session(), pool, {})
  expect(polling.mock.calls.map(call => call[0])).toEqual([1000, 1000])
  expect((await pool.accounts.list())).toHaveLength(1)
})

it.each([500, 'missing-token', 'empty-token', 'invalid-jwt'])('handles Cursor login response %s without exposing provider data', async (kind) => {
  const pool = await poolFor('cursor')
  const response = typeof kind === 'number' ? new Response('private provider error', { status: kind })
    : Response.json({ accessToken: kind === 'missing-token' ? 1 : kind === 'empty-token' ? '' : 'header.W10.signature', refreshToken: 'refresh' })
  vi.stubGlobal('fetch', vi.fn(async () => response))
  if (kind === 'invalid-jwt') {
    await loginCursor(session(), pool, {})
    expect(await pool.accounts.list()).toHaveLength(1)
  } else {
    await expect(loginCursor(session(), pool, {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(await pool.accounts.list()).toEqual([])
  }
})

it.each(['registration', 'device', 'verification', 'denied'] as const)('rejects Kiro %s failure before storing credentials', async (stage) => {
  const pool = await poolFor('kiro')
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/client/register')) return stage === 'registration' ? new Response('private', { status: 403 }) : Response.json({ clientId: 'client', clientSecret: 'secret' })
    if (url.endsWith('/device_authorization')) return stage === 'device' ? new Response('private', { status: 403 })
      : Response.json({ deviceCode: 'device', userCode: 'code', verificationUri: stage === 'verification' ? 'http://bad.test' : 'https://verify.test', expiresIn: 600 })
    return Response.json({ error: 'access_denied' }, { status: 400 })
  })
  vi.stubGlobal('fetch', fetcher)
  await expect(loginKiro(session(), pool, {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  expect(await pool.accounts.list()).toEqual([])
})

it('follows AWS exception polling and stores provider-issued profile metadata with configured identity settings', async () => {
  const pool = await poolFor('kiro')
  const tokens = [Response.json({ __type: 'AuthorizationPendingException' }, { status: 400 }), Response.json({ __type: 'SlowDownException' }, { status: 400 }),
    Response.json({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, profileArn: 'arn:provider:profile' })]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toContain('oidc.eu-west-1.amazonaws.com')
    if (url.endsWith('/client/register')) {
      expect(JSON.parse(init.body as string)).toMatchObject({ issuerUrl: 'https://issuer.test' })
      return Response.json({ clientId: 'client', clientSecret: 'secret' })
    }
    if (url.endsWith('/device_authorization')) {
      expect(JSON.parse(init.body as string)).toMatchObject({ startUrl: 'https://start.test' })
      return Response.json({ deviceCode: 'device', userCode: 'code', verificationUri: 'https://verify.test', expiresIn: 600 })
    }
    return tokens.shift()!
  }))
  await loginKiro(session(), pool, { region: 'eu-west-1', startURL: 'https://start.test', issuerURL: 'https://issuer.test', loginTimeoutMs: 1_000_000 })
  expect(polling.mock.calls.map(call => call[0])).toEqual([5000, 5000, 10000])
  const account = (await pool.accounts.list())[0]!
  expect(await pool.withAccount(account.id, () => pool.credentials.read('kiro'))).toMatchObject({ profileArn: 'arn:provider:profile', region: 'eu-west-1' })
})

it.each(['private error', null])('rejects a native refresh rejection with body %s and an account without an OAuth grant', async (body) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 401 })))
  await expect(refreshNativeAccount('cursor', { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1 }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  const pool = await poolFor('kiro')
  const account = await pool.add('Invalid', { type: 'api_key', key: 'unsupported' })
  await expect(nativeCredential(pool, 'kiro', account.id, new AbortController().signal)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
})

it.each(['cursor', 'kiro'] as const)('persists the %s rotating refresh token while retaining its native client metadata', async (provider) => {
  const fetcher = vi.fn(async () => Response.json({ accessToken: 'renewed', refreshToken: 'rotated', expiresIn: 3600 }))
  vi.stubGlobal('fetch', fetcher)
  const current: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'old-refresh', expires: 1,
    clientId: 'client', clientSecret: 'secret', region: 'us-east-1', profileArn: 'arn:issued:profile' }
  const updated = await refreshNativeAccount(provider, current, new AbortController().signal)
  expect(updated).toMatchObject({ access: 'renewed', refresh: 'rotated', clientId: 'client', profileArn: 'arn:issued:profile' })
  expect(updated.expires).toBeGreaterThan(Date.now() + 3_500_000)
  expect(fetcher).toHaveBeenCalledOnce()
})

it('bounds account JSON while reading and cancels an oversized provider body', async () => {
  const canceled = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(1024 * 1024 + 1))
  }, cancel: canceled }))
  await expect(accountJson(response, new AbortController().signal)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  expect(canceled).toHaveBeenCalledOnce()
})

it('accepts the new account routes and rejects unsupported Kiro controls at configuration', () => {
  expect([...resolveProfiles({ claude: {}, 'xai-account': {}, kimi: {}, cursor: {}, kiro: {} }).keys()]).toEqual(['claude', 'xai-account', 'kimi', 'cursor', 'kiro'])
  expect(() => resolveProfiles({ kiro: { defaultMaxTokens: 100 } })).toThrow('Kiro does not support')
  expect(() => resolveProfiles({ kiro: { models: [{ id: 'claude', maxTokens: 100 }] } })).toThrow('Kiro models do not support')
  expect(() => resolveProfiles({ kiro: { issuerURL: 'http://bad.test' } })).toThrow('issuerURL')
  expect(() => resolveProfiles({ cursor: { loginPollIntervalMs: Infinity } })).toThrow('positive timer')
})
