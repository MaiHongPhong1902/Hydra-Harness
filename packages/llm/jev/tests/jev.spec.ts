import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import * as Jev from '../src/index.ts'

let context: Context | undefined

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
