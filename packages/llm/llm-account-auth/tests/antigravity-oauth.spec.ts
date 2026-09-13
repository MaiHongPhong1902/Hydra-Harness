import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '@hydra/harness-llm'
import {
  ANTIGRAVITY_API_ENDPOINT,
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_TOKEN_ENDPOINT,
  ANTIGRAVITY_USERINFO_ENDPOINT,
  exchangeAntigravityCode,
  loadAntigravityProject,
  loginAntigravity,
  refreshAntigravity,
} from '../src/antigravity-oauth.ts'
import type {
  AntigravityAuthorizationInteraction,
  AntigravityFetch,
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
  it('keeps CSRF state independent from the PKCE verifier and accepts a valid callback after a mismatch', async () => {
    const provider = successfulFetch()
    const surface = noticePromise()
    const login = loginAntigravity(surface.interaction, {
      fetch: provider.fetch,
      callbackPort: 0,
      now: () => 1_000,
    })
    const authorization = await surface.notified
    const state = authorization.searchParams.get('state')
    const redirect = new URL(authorization.searchParams.get('redirect_uri') ?? '')
    const callback = `http://127.0.0.1:${redirect.port}${redirect.pathname}`
    expect(state).toEqual(expect.any(String))
    expect(authorization.searchParams.get('code_challenge')).toEqual(expect.any(String))

    const mismatch = await fetch(`${callback}?code=wrong&state=stale-state`)
    expect(mismatch.status).toBe(400)
    const valid = await fetch(`${callback}?code=auth-code&state=${encodeURIComponent(state ?? '')}`)
    expect(valid.status).toBe(200)
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
