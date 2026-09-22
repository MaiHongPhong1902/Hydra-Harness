import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import { SettingsProvider, settingsNamespace } from '@hydra/harness-settings'
import * as Jev from '../src/index.ts'

let context: Context | undefined

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(): Promise<void> { return Promise.resolve() }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('jev capability', () => {
  const request: Jev.JevSystemOneRequest = { state: 'visible', questions: {
    action: { type: 'choice', instructions: 'choose an action', criteria: { click: 'click', stop: 'stop' } },
    allowed: { type: 'noul', instructions: 'is this allowed?' },
    rating: { type: 'score', instructions: 'rate this', criteria: ['bad', 'good'] },
  } }
  const response = {
    model: 'typesafe-ai/jev', answers: {
      action: { type: 'choice', choice: 'click', confidence: 0.9 },
      allowed: { type: 'noul', noul: 0.7 }, rating: { type: 'score', score: 0.8, confidence: 0.9 },
    }, usage: { input_tokens: 4, output_tokens: 2 },
  }

  it('uses composition defaults and preserves an explicit error cause', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    const fetch = vi.fn(async () => Response.json(response))
    vi.stubGlobal('fetch', fetch)
    context = new Context()
    await context.plugin({ apply: (ctx: Context) => { Jev.apply(ctx) } }).await()
    await expect(context.jev.systemOne(request)).resolves.toEqual(response)
    expect(fetch).toHaveBeenCalledWith('https://www.jevai.org/api/v1/decisions', expect.any(Object))
    const cause = new Error('inner')
    expect(new Jev.JevError('safe', 'TRANSPORT', { cause }).cause).toBe(cause)
  })

  it.each<[Jev.Config, string]>([
    [{ apiKeyEnv: 'bad-key' }, 'credential reference'], [{ model: ' ' }, 'non-empty'],
    [{ baseURL: '/relative' }, 'absolute URL'], [{ baseURL: 'http://jev.test' }, 'HTTPS'],
    ...['https://user@jev.test', 'https://:secret@jev.test', 'https://jev.test?x', 'https://jev.test#x']
      .map(baseURL => [{ baseURL }, 'credentials, query, or fragment'] as [Jev.Config, string]),
    ...[0, 1.5, 2_147_483_648].map(timeoutMs => [{ timeoutMs }, 'timer interval'] as [Jev.Config, string]),
  ])('rejects unusable configuration before publishing the service: %j', (config, message) => {
    context = new Context()
    expect(() => { Jev.apply(context!, config) }).toThrow(message)
    expect(context.get('jev')).toBeUndefined()
  })

  it('observes settings changes per call and reverts to composition when settings unload', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    const fetch = vi.fn(async () => Response.json(response))
    vi.stubGlobal('fetch', fetch)
    context = new Context()
    const settings = context.plugin(MemorySettings)
    await settings.await()
    await context.plugin(Jev, { model: 'composed' }).await()
    const ns = settingsNamespace('jev')
    await context.settings.update(ns, { model: 'updated', baseURL: 'https://updated.test/' })
    await context.jev.systemOne(request)
    expect(fetch).toHaveBeenLastCalledWith('https://updated.test/api/v1/decisions', expect.objectContaining({
      body: JSON.stringify({ ...request, model: 'updated' }),
    }))
    await expect(context.settings.update(ns, { baseURL: 'http://bad.test' })).rejects.toThrow('HTTPS')
    await settings.dispose()
    await context.jev.systemOne(request)
    expect(fetch).toHaveBeenLastCalledWith('https://www.jevai.org/api/v1/decisions', expect.objectContaining({
      body: JSON.stringify({ ...request, model: 'composed' }),
    }))
  })

  it('passes nested JSON and boolean criteria, retaining the per-call model override', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => Response.json({ model: '', answers: response.answers }))
    vi.stubGlobal('fetch', fetch)
    context = new Context()
    await context.plugin(Jev).await()
    for (const criteria of [null, { true: { nested: [true, null, 2] }, false: 'no' }] as const) {
      const result = await context.jev.systemOne({ ...request, model: 'override', state: [false, { depth: [1] }],
        questions: { ...request.questions, allowed: { ...request.questions.allowed!, type: 'noul', criteria: criteria as never } },
      })
      expect(result.model).toBe('override')
      expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string)).toMatchObject({ model: 'override' })
    }
  })

  it('refuses calls cancelled before admission or after disposal without transport', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    context = new Context()
    const fiber = context.plugin(Jev)
    await fiber.await()
    const service = context.jev
    await expect(service.systemOne(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' })
    await fiber.dispose()
    await expect(service.systemOne(request)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([0, 1.5, 2_147_483_648])('refuses timeout %s before transport', async (timeoutMs) => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    context = new Context()
    await context.plugin(Jev).await()
    await expect(context.jev.systemOne(request, { timeoutMs })).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses non-header credential characters before transport', async () => {
    vi.stubEnv('JEV_API_KEY', 'key\nsecond')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    context = new Context()
    await context.plugin(Jev).await()
    await expect(context.jev.systemOne(request)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('contains network failures without exposing transport diagnostics', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret transport text')))
    context = new Context()
    await context.plugin(Jev).await()
    await expect(context.jev.systemOne(request)).rejects.toMatchObject({ code: 'TRANSPORT', message: 'jev: provider request failed' })
  })

  it.each([
    [null, 'INVALID_RESPONSE'], [{ code: 3 }, 'TRANSPORT'], [{ code: 0, data: null }, 'INVALID_RESPONSE'],
  ])('rejects invalid provider envelopes: %j', async (body, code) => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    context = new Context()
    await context.plugin(Jev).await()
    await expect(context.jev.systemOne(request)).rejects.toMatchObject({ code })
  })

  it('accepts all three decision types and removes its service on disposal', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))
    context = new Context()
    const fiber = context.plugin(Jev)
    await fiber.await()
    expect(await context.jev.systemOne(request)).toEqual(response)
    await fiber.dispose()
    expect(context.get('jev')).toBeUndefined()
  })

  it.each([[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'TRANSPORT']] as const)(
    'contains HTTP %s without exposing the response body', async (status, code) => {
      vi.stubEnv('JEV_API_KEY', 'test-key')
      vi.stubGlobal('fetch', vi.fn(async () => new Response('test-key', { status })))
      context = new Context()
      await context.plugin(Jev).await()
      await expect(context.jev.systemOne(request)).rejects.toMatchObject({ code, status })
      await expect(context.jev.systemOne(request)).rejects.not.toThrow('test-key')
    })

  it.each([
    {}, { ...response, answers: {} },
    { ...response, usage: { input_tokens: -1, output_tokens: 0 } },
    { ...response, answers: { ...response.answers, action: { type: 'choice', choice: 'other', confidence: 1 } } },
    { ...response, answers: { ...response.answers, allowed: { type: 'noul', noul: 2 } } },
    { ...response, answers: { ...response.answers, rating: { type: 'score', score: 2, confidence: 1 } } },
  ])('rejects malformed upstream decisions', async (body) => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    context = new Context()
    await context.plugin(Jev).await()
    await expect(context.jev.systemOne(request)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each(['timeout', 'cancel', 'dispose'] as const)('settles a stalled response body on %s', async (mode) => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    const started = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        options.signal?.addEventListener('abort', () => { controller.error(new Error('aborted')) }, { once: true })
        started.resolve(undefined)
      },
    }))))
    context = new Context()
    const fiber = context.plugin(Jev)
    await fiber.await()
    const abort = new AbortController()
    const run = context.jev.systemOne(request, { signal: abort.signal, timeoutMs: mode === 'timeout' ? 20 : 1000 })
    const settled = expect(run).rejects.toMatchObject({ code: mode === 'timeout' ? 'TIMEOUT' : 'CANCELLED' })
    await started.promise
    if (mode === 'cancel') abort.abort()
    if (mode === 'dispose') await fiber.dispose()
    await settled
  })

  it('boots without a key and reports the missing credential only on use', async () => {
    vi.stubEnv('JEV_API_KEY', '')
    context = new Context()
    await context.plugin(Jev).await()
    await expect(context.get('jev')!.systemOne({
      state: 'button is visible',
      questions: { action: { type: 'choice', instructions: 'what next?', criteria: { click: 'click', stop: 'stop' } } },
    })).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('sends one validated request and projects the response', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' })
      expect(JSON.parse(init?.body as string)).toMatchObject({ model: 'typesafe-ai/jev' })
      return new Response(JSON.stringify({
        model: 'typesafe-ai/jev',
        answers: { action: { type: 'choice', choice: 'click', confidence: 0.9 } },
        usage: { input_tokens: 4, output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    context = new Context()
    await context.plugin(Jev, { baseURL: 'https://jev.test' }).await()
    const result = await context.get('jev')!.systemOne({
      state: { button: 'visible' },
      questions: { action: { type: 'choice', instructions: 'choose an action', criteria: { click: 'click', stop: 'stop' } } },
    })
    expect(result.answers.action).toMatchObject({ type: 'choice', choice: 'click' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('unwraps the documented Jev API envelope without requiring usage fields', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      code: 0,
      message: 'ok',
      data: {
        answers: { action: { type: 'choice', choice: 'click', confidence: 0.9 } },
      },
    })))
    context = new Context()
    await context.plugin(Jev).await()
    await expect(context.jev.systemOne({
      state: 'visible',
      questions: { action: { type: 'choice', instructions: 'choose', criteria: { click: 'click', stop: 'stop' } } },
    })).resolves.toMatchObject({ model: 'typesafe-ai/jev', answers: { action: { choice: 'click' } } })
  })

  it.each([
    null,
    { state: undefined, questions: request.questions },
    { state: { invalid: undefined }, questions: request.questions },
    { state: 'visible', questions: {} },
    { state: 'visible', questions: { action: { type: 'score', criteria: ['only'] } } },
    { state: 'visible', questions: { action: { type: 'unknown' } } },
    { ...request, model: 7 }, { ...request, model: ' ' },
    ...[[], { other: 'no' }, { true: undefined }].map(criteria => ({ state: [], questions: {
      action: { type: 'noul', instructions: 'yes?', criteria },
    } })),
  ])('rejects invalid request input before transport', async (invalid) => {
    vi.stubEnv('JEV_API_KEY', 'test-key')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    context = new Context()
    await context.plugin(Jev).await()
    await expect(context.jev.systemOne(invalid as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
