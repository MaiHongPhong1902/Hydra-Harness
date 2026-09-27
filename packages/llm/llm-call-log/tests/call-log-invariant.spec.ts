/** Own companion startup to exercise adoption of sessions that already contain calls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra1902/cordis'
import LlmRuntime, { CallId, LlmAdapter, LlmError, markAgentLoopRequest, ReasoningEffortId } from '@hydra1902/harness-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@hydra1902/harness-llm'
import SessionStore, { SessionId, type Session } from '@hydra1902/harness-session'
import InvariantRegistry from '@hydra1902/harness-invariants'
import * as log from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

class Adapter extends LlmAdapter {
  constructor(private readonly run: (options: GenerateOptions) => AsyncIterable<StreamChunk>) { super() }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] } }
  }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return this.run(options) }
}

async function setup(run: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(invariant)
  const fiber = ctx.plugin(log)
  await fiber
  ctx.llm.registerAdapter(['mock'], new Adapter(run))
  const session = ctx.sessions.create(SessionId('call-log'))
  const options: GenerateOptions = { provider: 'mock', model: 'model-a', sessionId: session.id, messages: [] }
  return { ctx, session, options, fiber }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function records(session: Session) {
  return session.events.filter(event => event.type.startsWith('llm/call-'))
}

describe('model call diagnostics', () => {
  it('separates reasoning, visible text, advertised tools, and requested tools without altering the stream', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const callId = CallId('call-read')
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'text-delta', index: 1, text: 'hello' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: 'read', arguments: '{"secret":"omit"}' } },
      { type: 'usage', usage: { inputTokens: 42, outputTokens: 3, reasoningTokens: 2 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const { ctx, session, options } = await setup(async function* () {
      for (const chunk of chunks) { now += 10; yield chunk }
    })
    session.append('step/start', { turn: 2, step: 3 })
    Object.assign(options, {
      system: 'private prompt', maxTokens: 100, reasoningEffort: ReasoningEffortId('low'),
      tools: [{ name: 'read', description: 'private description', parameters: {} }, { name: 'write', description: '', parameters: {} }],
    })
    markAgentLoopRequest(options)
    expect(await collect(ctx.llm.stream(options))).toEqual(chunks)
    expect(records(session).map(event => ({ type: event.type, data: event.data }))).toEqual([
      { type: 'llm/call-start', data: { provider: 'mock', model: 'model-a', purpose: 'conversation', turn: 2, step: 3,
        messageCount: 0, systemChars: 14, tools: ['read', 'write'], maxTokens: 100, reasoningEffort: 'low' } },
      { type: 'llm/call-first-output', data: { provider: 'mock', model: 'model-a', callSeq: 1, kind: 'reasoning', elapsedMs: 30 } },
      { type: 'llm/call-end', data: { provider: 'mock', model: 'model-a', callSeq: 1, outcome: 'tool-calls', elapsedMs: 70,
        firstOutputMs: 30, firstTextMs: 40, toolCalls: [{ callId, name: 'read' }], usage: { inputTokens: 42, outputTokens: 3, reasoningTokens: 2 } } },
    ])
    expect(JSON.stringify(records(session))).not.toMatch(/private|secret|thinking|hello/)
    expect(session.deriveMessages()).toEqual([])
  })

  it('correlates overlapping auxiliary models in the same session and passes unassociated calls through', async () => {
    const { ctx, session, options } = await setup(async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await Promise.all([
      collect(ctx.llm.stream({ ...options, purpose: 'session-title' })),
      collect(ctx.llm.stream({ ...options, model: 'model-b', purpose: 'compaction' })),
    ])
    const starts = session.events.filter(event => event.type === 'llm/call-start')
    const ends = session.events.filter(event => event.type === 'llm/call-end')
    expect(starts.map(event => event.data.purpose)).toEqual(['session-title', 'compaction'])
    expect(ends.map(event => [event.data.callSeq, event.data.model])).toEqual(starts.map(event => [event.seq, event.data.model]))
    expect(starts.every(event => event.data.turn === undefined)).toBe(true)
    const length = session.events.length
    await collect(ctx.llm.stream({ provider: 'mock', model: 'model-a', messages: [] }))
    await collect(ctx.llm.stream({ ...options, sessionId: SessionId('absent') }))
    expect(session.events).toHaveLength(length)
  })

  it('records failed attempts separately, omits secret error messages, and removes its listener on disposal', async () => {
    let attempts = 0
    const { ctx, session, options, fiber } = await setup(async function* () {
      if (++attempts === 1) throw new LlmError('secret upstream response', 'SERVER')
      yield { type: 'tool-call-delta', index: 0, id: CallId('partial'), name: 'read', argumentsDelta: '' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await collect(ctx.llm.stream(options))
    await collect(ctx.llm.stream(options))
    const ends = session.events.filter(event => event.type === 'llm/call-end')
    expect(ends.map(event => event.data.outcome)).toEqual(['error', 'stop'])
    expect(ends[0]?.data).toMatchObject({ callSeq: 0, errorCode: 'SERVER', toolCalls: [] })
    expect(ends[1]?.data).toMatchObject({ callSeq: 2, toolCalls: [] })
    expect(session.events.find(event => event.type === 'llm/call-first-output')?.data).toMatchObject({ kind: 'tool-call' })
    expect(JSON.stringify(records(session))).not.toContain('secret')
    await fiber.dispose()
    const length = session.events.length
    await collect(ctx.llm.stream(options))
    expect(session.events).toHaveLength(length)
  })

  it.each([false, true])('settles an early consumer close with aborted=%s', async (abort) => {
    const controller = new AbortController()
    const { ctx, session, options } = await setup(async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    for await (const _chunk of ctx.llm.stream({ ...options, signal: controller.signal })) {
      if (abort) controller.abort()
      break
    }
    expect(session.events.at(-1)?.data).toMatchObject({ outcome: abort ? 'aborted' : 'closed' })
  })

  it('preserves middleware throws and does not fabricate a successful completion', async () => {
    const { ctx, session, options } = await setup(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })
    const failure = new Error('middleware failed')
    ctx.on('llm/stream', () => { throw failure })
    await expect(collect(ctx.llm.stream(options))).rejects.toBe(failure)
    expect(session.events.at(-1)?.data).toMatchObject({ outcome: 'exception' })
  })

  it('records an aborting middleware failure and stops recording after session detachment', async () => {
    const controller = new AbortController()
    const { ctx, session, options } = await setup(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })
    const dispose = ctx.on('llm/stream', () => {
      controller.abort()
      throw new Error('cancelled')
    })
    await expect(collect(ctx.llm.stream({ ...options, signal: controller.signal }))).rejects.toThrow('cancelled')
    expect(session.events.at(-1)?.data).toMatchObject({ outcome: 'aborted' })
    dispose()
    const detached = ctx.sessions.prepare(SessionId('detached'))
    const detach = ctx.sessions.enter(detached)
    ctx.on('llm/stream', async function* () {
      detach()
      yield { type: 'text-delta', index: 0, text: 'late' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(await collect(ctx.llm.stream({ ...options, sessionId: detached.id }))).toHaveLength(2)
    expect(records(detached).map(event => event.type)).toEqual(['llm/call-start'])
  })

  it('validates existing and restored call records when the companion adopts sessions', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('existing'))
    session.append('llm/call-start', { provider: 'mock', model: 'a', purpose: 'auxiliary', messageCount: 0, systemChars: 0, tools: [] })
    session.append('llm/call-end', { provider: 'mock', model: 'a', callSeq: 0, outcome: 'stop', elapsedMs: 0, toolCalls: [] })
    expect(ctx.sessions.list()).toHaveLength(1)
    await ctx.plugin(InvariantRegistry)
    expect(ctx.sessions.list()).toHaveLength(1)
    await ctx.plugin(invariant)
    const restored = ctx.sessions.create(SessionId('restored'), { seed: [...session.events] })
    expect(records(restored)).toHaveLength(2)
  })

  it('rejects mismatched routes, orphaned records, duplicate ends, and inconsistent timing', async () => {
    const { session } = await setup(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })
    const start = session.append('llm/call-start', { provider: 'mock', model: 'a', purpose: 'auxiliary', messageCount: 0, systemChars: 0, tools: [] })
    const end = { provider: 'mock', model: 'a', callSeq: start.seq, outcome: 'stop' as const, elapsedMs: 5, toolCalls: [] }
    expect(() => session.append('llm/call-end', { ...end, callSeq: 99 })).toThrow(/earlier start/)
    expect(() => session.append('llm/call-end', { ...end, model: 'b' })).toThrow(/same provider and model/)
    expect(() => session.append('llm/call-end', { ...end, elapsedMs: -1 })).toThrow(/non-negative/)
    expect(() => session.append('llm/call-end', { ...end, firstOutputMs: 2 })).toThrow(/first output/)
    session.append('llm/call-end', end)
    expect(() => session.append('llm/call-end', end)).toThrow(/repeat/)
  })
})
