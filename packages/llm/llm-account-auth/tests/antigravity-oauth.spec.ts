import { describe, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { LlmError } from '@hydra/harness-llm'
import {
  ANTIGRAVITY_API_ENDPOINT,
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_TOKEN_ENDPOINT,
  ANTIGRAVITY_USERINFO_ENDPOINT,
  buildAntigravityAuthorizationUrl,
  exchangeAntigravityCode,
  loadAntigravityProject,
  loginAntigravity,
  refreshAntigravity,
} from '../src/antigravity-oauth.ts'
import type {
  AntigravityAuthorizationInteraction,
  AntigravityFetch,
  AntigravityOAuthOptions,
} from '../src/antigravity-oauth.ts'

interface FetchCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

function fetcher(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): {
  readonly fetch: AntigravityFetch
  readonly calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const implementation = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetch: implementation, calls }
}

function successfulFetch(): { readonly fetch: AntigravityFetch; readonly calls: FetchCall[] } {
  return fetcher(async (url) => {
    if (url === ANTIGRAVITY_TOKEN_ENDPOINT) {
      return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 })
    }
    if (url === ANTIGRAVITY_USERINFO_ENDPOINT) return Response.json({ email: 'user@example.test' })
    if (url === `${ANTIGRAVITY_API_ENDPOINT}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`) {
      return Response.json({ cloudaicompanionProject: 'project-id' })
    }
    throw new Error(`unexpected Antigravity request: ${url}`)
  })
}

function noticePromise(): {
  readonly interaction: AntigravityAuthorizationInteraction
  readonly notified: Promise<URL>
  readonly promptKinds: string[]
} {
  let resolveNotice: (url: URL) => void = () => undefined
  const notified = new Promise<URL>((resolve) => { resolveNotice = resolve })
  const promptKinds: string[] = []
  return {
    notified,
    promptKinds,
    interaction: {
      notify: (notice) => { if (notice.url !== undefined) resolveNotice(new URL(notice.url)) },
      prompt: (prompt) => {
        promptKinds.push(prompt.kind)
        return new Promise<string>(() => undefined)
      },
    },
  }
}

describe('Antigravity OAuth', () => {
  it.each([true, false])('cancels before or during listener startup: before=%s', async (before) => {
    const controller = new AbortController()
    if (before) controller.abort('cancelled')
    const provider = successfulFetch()
    const surface = noticePromise()
    const login = loginAntigravity({ ...surface.interaction, signal: controller.signal }, { fetch: provider.fetch, callbackPort: 0 })
    if (!before) controller.abort('cancelled')
    await expect(login).rejects.toMatchObject({ code: 'ABORTED' })
    expect(provider.calls).toEqual([])
  })

  it('observes cancellation initiated by the authorization notice', async () => {
    const controller = new AbortController()
    await expect(loginAntigravity({
      signal: controller.signal, notify: () => { controller.abort('notice cancelled') },
      prompt: () => new Promise<string>(() => undefined),
    }, { callbackPort: 0 })).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it.each(['invalid-url', 'missing-state', 'stale-state', 'missing-code'])('rejects a malformed manual callback: %s', async (kind) => {
    const surface = noticePromise()
    const provider = successfulFetch()
    await expect(loginAntigravity({
      notify: (notice) => { surface.interaction.notify(notice) },
      prompt: async () => {
        if (kind === 'invalid-url') return 'not a URL'
        const authorization = await surface.notified
        const callback = new URL(authorization.searchParams.get('redirect_uri')!)
        if (kind !== 'missing-state') callback.searchParams.set('state', kind === 'stale-state' ? 'stale' : authorization.searchParams.get('state')!)
        if (kind !== 'missing-code') callback.searchParams.set('code', 'code')
        return callback.href
      },
    }, { fetch: provider.fetch, callbackPort: 0 })).rejects.toMatchObject({
      code: kind === 'invalid-url' || kind === 'missing-code' ? 'INVALID_AUTH_RESPONSE' : 'AUTH_STATE_MISMATCH',
    })
    expect(provider.calls).toEqual([])
  })

  it.each(['network', 'status', 'json', 'no-email'])('retains a manually authorized grant when optional userinfo fails: %s', async (kind) => {
    const surface = noticePromise()
    const base = successfulFetch()
    const provider = fetcher((url, init) => {
      if (url !== ANTIGRAVITY_USERINFO_ENDPOINT) return base.fetch(url, init)
      if (kind === 'network') throw new Error('userinfo unavailable')
      if (kind === 'status') return new Response('unavailable', { status: 503 })
      if (kind === 'json') return new Response('invalid json')
      return Response.json({})
    })
    const grant = await loginAntigravity({
      notify: (notice) => { surface.interaction.notify(notice) },
      prompt: async () => {
        const authorization = await surface.notified
        return `${authorization.searchParams.get('redirect_uri')}?code=manual&state=${authorization.searchParams.get('state')}`
      },
    }, { fetch: provider.fetch, callbackPort: 0, callbackHost: kind === 'network' ? '::1' : '127.0.0.1' })
    expect(grant).toMatchObject({ access: 'access-token', refresh: 'refresh-token', projectId: 'project-id' })
    expect(grant).not.toHaveProperty('email')
  })

  it('propagates cancellation during userinfo instead of continuing project setup', async () => {
    const controller = new AbortController()
    const surface = noticePromise()
    const base = successfulFetch()
    const provider = fetcher((url, init) => {
      if (url !== ANTIGRAVITY_USERINFO_ENDPOINT) return base.fetch(url, init)
      controller.abort('cancelled')
      throw new Error('aborted fetch')
    })
    await expect(loginAntigravity({
      signal: controller.signal, notify: (notice) => { surface.interaction.notify(notice) },
      prompt: async () => {
        const authorization = await surface.notified
        return `${authorization.searchParams.get('redirect_uri')}?code=manual&state=${authorization.searchParams.get('state')}`
      },
    }, { fetch: provider.fetch, callbackPort: 0 })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(provider.calls.map(call => call.url)).toEqual([ANTIGRAVITY_TOKEN_ENDPOINT, ANTIGRAVITY_USERINFO_ENDPOINT])
  })

  it.each(['error=denied', ''])('rejects a matching-state callback without an authorization code: %s', async (query) => {
    const surface = noticePromise()
    const login = loginAntigravity(surface.interaction, { callbackPort: 0 })
    const rejected = expect(login).rejects.toMatchObject({ code: query ? 'AUTH' : 'INVALID_AUTH_RESPONSE' })
    const authorization = await surface.notified
    const callback = new URL(authorization.searchParams.get('redirect_uri')!)
    callback.hostname = '127.0.0.1'
    callback.search = `${query}&state=${authorization.searchParams.get('state')}`
    expect((await fetch(callback)).status).toBe(400)
    await rejected
  })

  it('reports a listener port conflict without starting authorization', async () => {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('missing TCP address')
      await expect(loginAntigravity(noticePromise().interaction, { callbackPort: address.port }))
        .rejects.toMatchObject({ code: 'AUTH_LISTENER' })
    } finally { await new Promise<void>(resolve => server.close(() => { resolve() })) }
  })

  it.each([true, false])('cancels before or during an onboarding delay: before=%s', async (before) => {
    const controller = new AbortController()
    const subscribed = vi.spyOn(controller.signal, 'addEventListener')
    const provider = fetcher((url) => {
      if (url.endsWith(':loadCodeAssist')) return Response.json({})
      if (before) controller.abort('cancelled')
      return Response.json({ done: false })
    })
    const pending = loadAntigravityProject('access', { fetch: provider.fetch, onboardingDelayMs: 10_000 }, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    if (!before) {
      await vi.waitFor(() => { expect(subscribed).toHaveBeenCalledWith('abort', expect.any(Function), { once: true }) })
      controller.abort('cancelled')
    }
    await rejected
    subscribed.mockRestore()
  })

  it.each([
    { callbackPort: -1 }, { callbackPort: 65536 }, { callbackPort: 0.5 },
    { callbackPath: 'relative' }, { onboardingAttempts: 0 }, { onboardingAttempts: 1.5 },
    { onboardingDelayMs: -1 }, { onboardingDelayMs: Number.NaN },
  ] satisfies AntigravityOAuthOptions[])('rejects invalid transport configuration before fetching: %j', async (options) => {
    const provider = successfulFetch()
    await expect(loadAntigravityProject('access', { ...options, fetch: provider.fetch }))
      .rejects.toMatchObject({ code: 'INVALID_AUTH_CONFIG' })
    expect(provider.calls).toEqual([])
  })

  it('omits PKCE fields only when the caller supplies no challenge', () => {
    const url = new URL(buildAntigravityAuthorizationUrl('state', 'http://localhost/callback'))
    expect(url.searchParams.get('state')).toBe('state')
    expect(url.searchParams.has('code_challenge')).toBe(false)
    expect(url.searchParams.has('code_challenge_method')).toBe(false)
  })

  it.each([['', 'verifier'], ['code', ' ']])('rejects an empty code or verifier: %j', async (code, verifier) => {
    const provider = successfulFetch()
    await expect(exchangeAntigravityCode(code, 'http://localhost/callback', verifier, { fetch: provider.fetch }))
      .rejects.toMatchObject({ code: 'INVALID_AUTH_RESPONSE' })
    expect(provider.calls).toEqual([])
  })

  it.each([
    {}, { access_token: 'access' }, { access_token: 'access', refresh_token: 'refresh', expires_in: 'bad' },
    { access_token: 'access', refresh_token: 'refresh', expires_in: 0 },
  ])('rejects incomplete token exchange responses: %j', async (body) => {
    await expect(exchangeAntigravityCode('code', 'http://localhost/callback', 'verifier', {
      fetch: fetcher(() => Response.json(body)).fetch,
    })).rejects.toMatchObject({ code: 'INVALID_AUTH_RESPONSE' })
  })

  it.each([
    [401, 'unauthorized', 'AUTH'], [403, 'forbidden', 'AUTH'], [429, 'quota exhausted', 'QUOTA'],
    [429, 'too fast', 'RATE_LIMIT'], [500, 'server error', 'SERVER'], [302, 'redirect', 'AUTH'],
  ] as const)('classifies OAuth HTTP %s without retaining provider bodies', async (status, body, code) => {
    await expect(exchangeAntigravityCode('code', 'http://localhost/callback', 'verifier', {
      fetch: fetcher(() => new Response(body, { status })).fetch,
    })).rejects.toMatchObject({ code, failure: { status } })
  })

  it.each(['not-json', 'null', '[]'])('rejects malformed or non-object JSON: %s', async (body) => {
    await expect(exchangeAntigravityCode('code', 'http://localhost/callback', 'verifier', {
      fetch: fetcher(() => new Response(body)).fetch,
    })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('preserves HTTP classification when reading its error body fails', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('disconnected')) } })
    await expect(exchangeAntigravityCode('code', 'http://localhost/callback', 'verifier', {
      fetch: fetcher(() => new Response(body, { status: 500 })).fetch,
    })).rejects.toMatchObject({ code: 'SERVER', failure: { status: 500 } })
  })

  it.each([false, true])('distinguishes transport failure from cancellation: %s', async (cancel) => {
    const controller = new AbortController()
    const provider = fetcher(() => {
      if (cancel) controller.abort('cancelled')
      throw new Error('transport detail')
    })
    await expect(exchangeAntigravityCode('code', 'http://localhost/callback', 'verifier', {
      fetch: provider.fetch,
    }, controller.signal)).rejects.toMatchObject({ code: cancel ? 'ABORTED' : 'TRANSPORT' })
  })

  it.each([{ refresh: '', projectId: 'p' }, { refresh: 'r', projectId: '' }])('rejects unusable refresh input: %j', async (grant) => {
    await expect(refreshAntigravity(grant)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it.each([{}, { access_token: 'access', expires_in: 'bad' }, { access_token: 'access', expires_in: 0 }])(
    'rejects incomplete refresh responses: %j', async (body) => {
      await expect(refreshAntigravity({ refresh: 'r', projectId: 'p' }, {
        fetch: fetcher(() => Response.json(body)).fetch,
      })).rejects.toMatchObject({ code: 'INVALID_AUTH_RESPONSE' })
    },
  )

  it('accepts string lifetimes and persists rotated refresh tokens without inventing an email', async () => {
    const provider = fetcher(() => Response.json({ access_token: 'a', refresh_token: 'rotated', expires_in: '3600' }))
    expect(await exchangeAntigravityCode('code', 'http://localhost/callback', 'verifier', { fetch: provider.fetch }))
      .toEqual({ access: 'a', refresh: 'rotated', expiresIn: 3600 })
    expect(await refreshAntigravity({ refresh: 'r', projectId: 'p' }, { fetch: provider.fetch, now: () => 0 }))
      .toEqual({ access: 'a', refresh: 'rotated', projectId: 'p', expires: 3_300_000 })
  })

  it.each([
    { project: 'project' }, { projectId: 'project' }, { cloudaicompanionProject: { id: 'project' } },
    { cloudaicompanionProject: { projectId: 'project' } },
  ])('accepts supported project response fields: %j', async (body) => {
    await expect(loadAntigravityProject('access', { fetch: fetcher(() => Response.json(body)).fetch })).resolves.toBe('project')
  })

  it('rejects an absent project bearer token before fetching', async () => {
    await expect(loadAntigravityProject(' ')).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it.each([
    [{}, 'free-tier', { response: 'project' }],
    [{ allowedTiers: [null, { isDefault: false }, { isDefault: true, id: '' }], currentTier: { id: 'paid' } }, 'paid', { projectId: 'project' }],
  ] as const)('selects an onboarding tier and extracts its completed project: %j', async (load, tier, completion) => {
    const provider = fetcher((url, init) => {
      if (url.endsWith(':loadCodeAssist')) return Response.json(load)
      if (typeof init?.body !== 'string') throw new Error('onboarding did not send JSON')
      expect(JSON.parse(init.body)).toMatchObject({ tier_id: tier })
      return Response.json({ done: true, ...completion })
    })
    await expect(loadAntigravityProject('access', { fetch: provider.fetch })).resolves.toBe('project')
  })

  it('polls pending onboarding without a delay when zero is configured', async () => {
    let attempts = 0
    const provider = fetcher((url) => {
      if (url.endsWith(':loadCodeAssist')) return Response.json({})
      return Response.json(++attempts === 1 ? { done: false } : { done: true, response: { project: 'project' } })
    })
    await expect(loadAntigravityProject('access', { fetch: provider.fetch, onboardingDelayMs: 0 })).resolves.toBe('project')
    expect(attempts).toBe(2)
  })

  it.each([true, false])('rejects malformed completion or transport failure while onboarding: %s', async (done) => {
    const provider = fetcher((url) => {
      if (url.endsWith(':loadCodeAssist')) return Response.json({})
      if (done) return Response.json({ done: true })
      throw new Error('disconnected')
    })
    await expect(loadAntigravityProject('access', { fetch: provider.fetch }))
      .rejects.toMatchObject({ code: done ? 'INVALID_AUTH_RESPONSE' : 'TRANSPORT' })
  })

  it('keeps CSRF state independent from the PKCE verifier and accepts a valid callback after a mismatch', async () => {
    const provider = successfulFetch()
    const tokenReady: PromiseWithResolvers<void> = Promise.withResolvers()
    const held = fetcher(async (url, init) => {
      if (url === ANTIGRAVITY_TOKEN_ENDPOINT) await tokenReady.promise
      return provider.fetch(url, init)
    })
    const surface = noticePromise()
    const login = loginAntigravity(surface.interaction, {
      fetch: held.fetch,
      callbackPort: 0,
      now: () => 1_000,
    })
    const authorization = await surface.notified
    const state = authorization.searchParams.get('state')
    const redirect = new URL(authorization.searchParams.get('redirect_uri') ?? '')
    const callback = `http://127.0.0.1:${redirect.port}${redirect.pathname}`
    expect(state).toEqual(expect.any(String))
    expect(authorization.searchParams.get('code_challenge')).toEqual(expect.any(String))

    expect((await fetch(callback, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`http://127.0.0.1:${redirect.port}/wrong-path`)).status).toBe(404)
    expect((await fetch(callback)).status).toBe(400)
    const malformed = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest({ hostname: '127.0.0.1', port: redirect.port, path: 'http://[' }, (response) => {
        response.resume()
        resolve(response.statusCode)
      }).on('error', reject).end()
    })
    expect(malformed).toBe(400)

    const mismatch = await fetch(`${callback}?code=wrong&state=stale-state`)
    expect(mismatch.status).toBe(400)
    const valid = await fetch(`${callback}?code=auth-code&state=${encodeURIComponent(state ?? '')}`)
    try {
      expect(valid.status).toBe(200)
      expect((await fetch(`${callback}?code=duplicate&state=${encodeURIComponent(state ?? '')}`)).status).toBe(200)
    } finally { tokenReady.resolve() }
    await expect(login).resolves.toMatchObject({
      access: 'access-token',
      refresh: 'refresh-token',
      projectId: 'project-id',
      email: 'user@example.test',
    })

    const tokenRequest = provider.calls.find(call => call.url === ANTIGRAVITY_TOKEN_ENDPOINT)
    const body = tokenRequest?.init?.body
    if (!(body instanceof URLSearchParams)) throw new Error('token exchange did not send a form')
    expect(body.get('code_verifier')).toEqual(expect.any(String))
    expect(body.get('code_verifier')).not.toBe(state)
    expect(surface.promptKinds).toEqual(['secret'])
    await expect(fetch(`${callback}?code=late&state=${encodeURIComponent(state ?? '')}`)).rejects.toThrow()
  })

  it('cancels a prompt that ignores its signal and closes the callback listener', async () => {
    const controller = new AbortController()
    const surface = noticePromise()
    let resolvePrompt: () => void = () => undefined
    const promptStarted = new Promise<void>((resolve) => { resolvePrompt = resolve })
    const interaction: AntigravityAuthorizationInteraction = {
      signal: controller.signal,
      notify: (notice) => { surface.interaction.notify(notice) },
      prompt: (prompt) => {
        surface.promptKinds.push(prompt.kind)
        resolvePrompt()
        return new Promise<string>(() => undefined)
      },
    }
    const provider = fetcher(async () => { throw new Error('network should not start after cancellation') })
    const login = loginAntigravity(interaction, { fetch: provider.fetch, callbackPort: 0 })
    const authorization = await surface.notified
    await promptStarted
    const redirect = new URL(authorization.searchParams.get('redirect_uri') ?? '')
    const callback = `http://127.0.0.1:${redirect.port}${redirect.pathname}`
    controller.abort('cancelled by test')
    await expect(login).rejects.toMatchObject({ code: 'ABORTED' })
    expect(surface.promptKinds).toEqual(['secret'])
    await expect(fetch(`${callback}?code=late&state=late`)).rejects.toThrow()
  })

  it('rejects non-loopback callback hosts before doing network work', async () => {
    await expect(loadAntigravityProject('access-token', {
      callbackHost: '0.0.0.0',
      fetch: fetcher(async () => Response.json({})).fetch,
    })).rejects.toMatchObject({ code: 'INVALID_AUTH_CONFIG' })
  })

  it.each(['/oauth?code=invalid', '/oauth#fragment'])('rejects callback path %s before starting a listener', async (callbackPath) => {
    const provider = successfulFetch()
    await expect(loginAntigravity(noticePromise().interaction, {
      callbackPath, fetch: provider.fetch,
    })).rejects.toMatchObject({ code: 'INVALID_AUTH_CONFIG' })
    expect(provider.calls).toEqual([])
  })

  it('removes the onboarding delay abort listener after each timer', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const provider = fetcher(async (url) => {
      if (url === `${ANTIGRAVITY_API_ENDPOINT}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`) {
        return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] })
      }
      return Response.json({ done: false })
    })

    await expect(loadAntigravityProject('access-token', {
      fetch: provider.fetch,
      onboardingAttempts: 2,
      onboardingDelayMs: 1,
    }, controller.signal)).rejects.toMatchObject({ code: 'ONBOARDING_TIMEOUT' })
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('preserves a refresh token when the provider omits rotation', async () => {
    const provider = fetcher(async () => Response.json({ access_token: 'new-access', expires_in: 60 }))
    await expect(refreshAntigravity({ refresh: 'old-refresh', projectId: 'project-id', email: 'user@example.test' }, {
      fetch: provider.fetch,
      now: () => 10_000,
    })).resolves.toEqual({
      access: 'new-access',
      refresh: 'old-refresh',
      expires: 10_000 + 60_000 - 300_000,
      projectId: 'project-id',
      email: 'user@example.test',
    })
  })

  it('keeps arbitrary provider response fields out of OAuth errors', async () => {
    const secrets = ['access-secret', 'refresh-secret', 'client-secret', 'bearer-secret']
    const provider = fetcher(async () => new Response(
      JSON.stringify({
        error: 'invalid_grant',
        access_token: secrets[0],
        refresh_token: secrets[1],
        client_secret: secrets[2],
        authorization: `Bearer ${secrets[3]}`,
        message: `Rejected credential ${secrets[0]}`,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ))

    let thrown: unknown
    try {
      await exchangeAntigravityCode('code', 'http://localhost:51121/oauth-callback', 'verifier', { fetch: provider.fetch })
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as Error).message).toBe('Antigravity token exchange failed with HTTP 400')
    for (const secret of secrets) expect((thrown as Error).message).not.toContain(secret)
  })
})
