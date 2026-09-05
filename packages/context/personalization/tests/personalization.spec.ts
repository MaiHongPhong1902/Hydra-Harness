import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@bosch/cordis'
import { createUserMessage, LlmAdapter } from '@bosch/bh-llm'
import type { GenerateOptions, StreamChunk } from '@bosch/bh-llm'
import { SessionId } from '@bosch/bh-session'
import type { SessionEvent } from '@bosch/bh-session'
import AgentLoop from '@bosch/bh-agent-loop'
import { mountAgentLoopTestDependencies } from '@bosch/bh-agent-loop-testkit'
import SettingsProvider, { settingsNamespace } from '@bosch/bh-settings'
import type { SettingsNamespace } from '@bosch/bh-settings'
import * as personalization from '@bosch/bh-personalization'
import { hasLoggedPersonality, LocalMemoryStore, resolveMemoryPolicy, resolveSessionPersonality } from '@bosch/bh-personalization'

/** In-memory settings provider: the Service Definition base class owns all tested behavior. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

describe('resolveSessionPersonality / hasLoggedPersonality', () => {
  it('defaults to pragmatic when no personality was ever logged', () => {
    expect(resolveSessionPersonality({ events: [] })).toBe('pragmatic')
    expect(hasLoggedPersonality({ events: [] })).toBe(false)
  })

  it('uses the last logged selection, newest winning', () => {
    // Provenance-only fixtures: the resolvers read type/data, not seq/time.
    const events = [
      { type: 'personalization/personality', data: { personality: 'friendly' } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'personalization/personality', data: { personality: 'none' } },
    ] as unknown as SessionEvent[]
    expect(resolveSessionPersonality({ events })).toBe('none')
    expect(hasLoggedPersonality({ events })).toBe(true)
  })
})

describe('LocalMemoryStore', () => {
  it('redacts, persists, and removes an explicit local memory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bh-memory-'))
    try {
      const store = new LocalMemoryStore(home)
      const entry = await store.add('token=super-secret-value and remember dark mode')
      expect(entry.text).toBe('token= [redacted] and remember dark mode')
      expect((await new LocalMemoryStore(home).list())).toEqual([entry])
      expect(await readFile(join(home, 'memories', 'memories.json'), 'utf8')).toContain('[redacted]')
      expect(await store.remove(entry.id)).toBe(true)
      expect(await store.remove(entry.id)).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

async function loopHarness(adapter: ScriptedAdapter, doc: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MemorySettings, { doc })
  await ctx.plugin(personalization)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

describe('personalization: real agent-loop request history', () => {
  it('prompts the pragmatic tone and logs nothing for the default personality', async () => {
    const adapter = new ScriptedAdapter([textResponse('ack')])
    const ctx = await loopHarness(adapter)
    const agent = ctx.agentLoop.create(SessionId('default'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.system).toContain('direct, matter-of-fact tone')
    // The default needs no provenance event: a session with none logged
    // already resolves to pragmatic.
    expect(hasLoggedPersonality(agent.session)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('seeds the session log and prompts a friendly tone when the global preference is friendly', async () => {
    const adapter = new ScriptedAdapter([textResponse('ack')])
    const ctx = await loopHarness(adapter, { personalization: { personality: 'friendly' } })
    const agent = ctx.agentLoop.create(SessionId('friendly'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests[0]!.system).toContain('warm, encouraging')
    expect(resolveSessionPersonality(agent.session)).toBe('friendly')
    expect(agent.session.events.filter(event => event.type === 'personalization/personality')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('adds no prompt text for the none personality, even though a preference is logged', async () => {
    const adapter = new ScriptedAdapter([textResponse('ack')])
    const ctx = await loopHarness(adapter, { personalization: { personality: 'none' } })
    const agent = ctx.agentLoop.create(SessionId('none'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests[0]!.system).not.toContain('tone')
    expect(resolveSessionPersonality(agent.session)).toBe('none')
    await ctx.fiber.dispose()
  })

  it('keeps an already-running agent on its session-start personality after the global preference changes mid-conversation', async () => {
    const adapter = new ScriptedAdapter([textResponse('first'), textResponse('second')])
    const ctx = await loopHarness(adapter, { personalization: { personality: 'friendly' } })
    const agent = ctx.agentLoop.create(SessionId('mid-conversation'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests[0]!.system).toContain('warm, encouraging')

    // The global preference changes after this session already logged its own
    // at session-start; the session's own log stays authoritative.
    const settings = ctx.get('settings')!
    await settings.update(settingsNamespace('personalization'), { personality: 'pragmatic' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests[1]!.system).toContain('warm, encouraging')
    expect(resolveSessionPersonality(agent.session)).toBe('friendly')
    expect(agent.session.events.filter(event => event.type === 'personalization/personality')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('injects an enabled local memory once and records the chat policy', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bh-memory-loop-'))
    const previousHome = process.env.BH_HOME
    process.env.BH_HOME = home
    try {
      const adapter = new ScriptedAdapter([textResponse('ack')])
      const ctx = await loopHarness(adapter, { memory: { enabled: true, useMemories: true, generateMemories: true } })
      await ctx.get('localMemories')!.add('User prefers concise Vietnamese answers')
      const agent = ctx.agentLoop.create(SessionId('memory-enabled'), { provider: 'mock', model: 'mock' })

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('User prefers concise Vietnamese answers')
      expect(adapter.requests[0]!.messages.filter(message => message.source.kind === 'plugin' && message.source.plugin === '@bosch/bh-personalization')).toHaveLength(1)
      expect(resolveMemoryPolicy(agent.session)).toEqual({ useMemories: true, generateMemories: true })
      await ctx.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.BH_HOME
      else process.env.BH_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not recall memories when the global switch is off', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bh-memory-off-'))
    const previousHome = process.env.BH_HOME
    process.env.BH_HOME = home
    try {
      const adapter = new ScriptedAdapter([textResponse('ack')])
      const ctx = await loopHarness(adapter, { memory: { enabled: false, useMemories: true, generateMemories: true } })
      await ctx.get('localMemories')!.add('must never reach this request')
      const agent = ctx.agentLoop.create(SessionId('memory-disabled'), { provider: 'mock', model: 'mock' })

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('must never reach this request')
      expect(resolveMemoryPolicy(agent.session)).toEqual({ useMemories: false, generateMemories: false })
      await ctx.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.BH_HOME
      else process.env.BH_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
})
