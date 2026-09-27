import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@hydra1902/cordis'
import { createUserMessage, LlmAdapter } from '@hydra1902/harness-llm'
import type { GenerateOptions, StreamChunk } from '@hydra1902/harness-llm'
import { SessionId } from '@hydra1902/harness-session'
import type { SessionEvent } from '@hydra1902/harness-session'
import AgentLoop from '@hydra1902/harness-agent-loop'
import { mountAgentLoopTestDependencies } from '@hydra1902/harness-agent-loop-testkit'
import SettingsProvider, { settingsNamespace } from '@hydra1902/harness-settings'
import type { SettingsNamespace } from '@hydra1902/harness-settings'
import CommandRuntime from '@hydra1902/harness-commands'
import { agentEvents, type PreStepDecision } from '@hydra1902/harness-agent'
import * as personalization from '@hydra1902/harness-personalization'
import { hasLoggedPersonality, LocalMemoryStore, resolveMemoryPolicy, resolveSessionPersonality } from '@hydra1902/harness-personalization'

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
  it('rejects malformed durable documents and enforces entry and text limits', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hydra-memory-validation-'))
    const path = join(home, 'memories', 'memories.json')
    const store = new LocalMemoryStore(home)
    try {
      await mkdir(join(home, 'memories'))
      for (const value of [null, [], 1, { version: 2, entries: [] }, { version: 1 },
        ...[null, 1, {}, { id: '', text: '' }, { id: '', text: '', createdAt: 1.5, updatedAt: 1 },
          { id: '', text: '', createdAt: 1, updatedAt: 1.5 },
          { id: ' ', text: 'valid', createdAt: 1, updatedAt: 1 },
          { id: 'valid', text: ' ', createdAt: 1, updatedAt: 1 },
          { id: 'valid', text: 'valid', createdAt: -1, updatedAt: 1 },
          { id: 'valid', text: 'valid', createdAt: 2, updatedAt: 1 },
          { id: 'valid', text: 'a'.repeat(2001), createdAt: 1, updatedAt: 1 },
        ].map(entry => ({ version: 1, entries: [entry] })),
        { version: 1, entries: Array.from({ length: 101 }, (_, index) => ({
          id: String(index), text: 'entry', createdAt: index, updatedAt: index,
        })) },
        { version: 1, entries: [{ id: 'duplicate', text: 'first', createdAt: 1, updatedAt: 1 }, {
          id: 'duplicate', text: 'second', createdAt: 2, updatedAt: 2,
        }] },
        { version: 1, entries: Array.from({ length: 20 }, (_, index) => ({
          id: String(index), text: 'a'.repeat(2000), createdAt: index, updatedAt: index,
        })) },
      ]) {
        await writeFile(path, JSON.stringify(value))
        await expect(store.list()).rejects.toThrow('memory document')
      }
      await expect(store.add('  ')).rejects.toThrow('1-2000')
      await expect(store.add('a'.repeat(2001))).rejects.toThrow('1-2000')
      const entries = Array.from({ length: 100 }, (_, index) => ({
        id: String(index), text: `entry ${index}`, createdAt: index, updatedAt: index,
      }))
      await writeFile(path, JSON.stringify({ version: 1, entries }))
      expect((await store.list())[0]?.id).toBe('99')
      await expect(store.add('one too many')).rejects.toThrow('limit of 100')
      await store.remove('0')
      expect((await store.add('a'.repeat(2000))).text).toHaveLength(2000)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('redacts, persists, and removes an explicit local memory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hydra-memory-'))
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

  it('rejects a write that would exceed the durable document limit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hydra-memory-document-limit-'))
    const path = join(home, 'memories', 'memories.json')
    try {
      await mkdir(join(home, 'memories'))
      await writeFile(path, JSON.stringify({ version: 1, entries: Array.from({ length: 17 }, (_, index) => ({
        id: String(index), text: 'a'.repeat(1_800), createdAt: index, updatedAt: index,
      })) }))
      await expect(new LocalMemoryStore(home).add('b'.repeat(2_000)))
        .rejects.toThrow('memory document exceeds 32768 bytes')
      expect(await new LocalMemoryStore(home).list()).toHaveLength(17)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('redacts common token and private-key formats before persistence', () => {
    const value = personalization.redactMemorySecrets([
      'Bearer abcdefghijklmnop',
      `eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`,
      'AKIA1234567890ABCDEF',
      'rk-abcdefghijklmnop',
      'AWS_SECRET_ACCESS_KEY=secret-value',
      '-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----',
    ].join(' '))
    expect(value).not.toContain('abcdefghijklmnop')
    expect(value).not.toContain('AKIA1234567890ABCDEF')
    expect(value).not.toContain('secret-value')
    expect(value).not.toContain('BEGIN PRIVATE KEY-----secret')
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
  it('keeps the logged default when a completed chat resumes after the global personality changes', async () => {
    const ctx = await loopHarness(new ScriptedAdapter([textResponse('ack')]))
    try {
      const agent = ctx.agentLoop.create(SessionId('existing-default'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await ctx.settings.update(settingsNamespace('personalization'), { personality: 'friendly' })
      agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })
      expect(hasLoggedPersonality(agent.session)).toBe(false)
      expect(resolveSessionPersonality(agent.session)).toBe('pragmatic')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('provides opt-in defaults when no settings provider is mounted', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(personalization)
    try {
      const section = (await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'personalization:personality')
      expect(section?.text).toContain('matter-of-fact')
      const agent = ctx.agentLoop.create(SessionId('no-settings'))
      expect(resolveMemoryPolicy(agent.session)).toEqual({ useMemories: false, generateMemories: false })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves seeded policy and recalls memory only at the first eligible proposal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hydra-memory-proposal-'))
    const previousHome = process.env.HYDRA_HOME
    process.env.HYDRA_HOME = home
    const ctx = await loopHarness(new ScriptedAdapter([]), { memory: { enabled: true } })
    try {
      const agent = ctx.agentLoop.create(SessionId('proposal'))
      const enter: PreStepDecision = { kind: 'enter', messages: [] }
      const propose = (step = 1, signal = new AbortController().signal, decision: PreStepDecision = enter) =>
        agentEvents(ctx, agent).waterfall('agent/pre-step', { turn: 1, step, signal, messages: [] }, async () => decision)
      expect(await propose()).toEqual(enter)
      await ctx.localMemories.add('keep answers short')
      expect(await propose(2)).toEqual(enter)
      expect(await propose(1, AbortSignal.abort())).toEqual(enter)
      const rejected: PreStepDecision = { kind: 'reject' }
      expect(await propose(1, new AbortController().signal, rejected)).toEqual(rejected)
      for (const source of [{ kind: 'user' }, { kind: 'plugin', plugin: 'other' },
        { kind: 'plugin', plugin: personalization.name, form: 'instructions' }] as const) {
        agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'context' }], source }), { surfaceOp: 'append' })
      }
      const recalled = await propose()
      if (recalled.kind !== 'enter') throw new Error('expected recall')
      expect(recalled.messages).toHaveLength(1)
      expect(recalled.messages[0]?.source).toEqual({ kind: 'plugin', plugin: personalization.name, form: 'recall' })
      agent.session.append('user/message', recalled.messages[0]!, { surfaceOp: 'append' })
      expect(await propose()).toEqual(enter)
      const originalPolicy = resolveMemoryPolicy(agent.session)
      agent.session.append('personalization/personality', { personality: 'friendly' })
      agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })
      expect(resolveSessionPersonality(agent.session)).toBe('friendly')
      expect(resolveMemoryPolicy(agent.session)).toEqual(originalPolicy)
      const child = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('memory-child'),
        meta: { parentSession: agent.id, delegationDepth: 1, seedLength: 0 },
      })
      await ctx.plugin(CommandRuntime)
      expect((await ctx.commands.execute(child.agent, '/memories list', [], new AbortController().signal))?.result)
        .toEqual({ kind: 'error', text: 'Memory controls are available only in a top-level chat.' })
      expect(await agentEvents(ctx, child.agent).waterfall('agent/pre-step', {
        turn: 1, step: 1, signal: new AbortController().signal, messages: [],
      }, async () => enter)).toEqual(enter)
    } finally {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.HYDRA_HOME
      else process.env.HYDRA_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  it('controls per-chat memory policy and stores only explicit accepted memories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hydra-memory-commands-'))
    const previousHome = process.env.HYDRA_HOME
    process.env.HYDRA_HOME = home
    const ctx = await loopHarness(new ScriptedAdapter([]), { memory: { enabled: true } })
    try {
      await ctx.plugin(CommandRuntime)
      const agent = ctx.agentLoop.create(SessionId('memory-commands'), { provider: 'mock', model: 'mock' })
      const command = async (input: string) => (await ctx.commands.execute(agent, `/memories ${input}`, [], new AbortController().signal))?.result
      expect(resolveMemoryPolicy({ events: [] })).toEqual({ useMemories: true, generateMemories: true })
      expect(await command('')).toEqual({ kind: 'success', text: 'Memory: use=on, save=on, 0 stored.' })
      expect(await command('list')).toEqual({ kind: 'success', text: 'No local memories.' })
      expect(await command('save off')).toMatchObject({ text: 'Memory save off.' })
      expect(await command('use off')).toMatchObject({ text: 'Memory use off.' })
      expect(await command('')).toMatchObject({ text: 'Memory: use=off, save=off, 0 stored.' })
      expect(await command('add remember me')).toMatchObject({ kind: 'error', text: 'Memory saving is off for this chat.' })
      expect(await command('save on')).toMatchObject({ text: 'Memory save on.' })
      expect(await command('use on')).toMatchObject({ text: 'Memory use on.' })
      expect(await command('add')).toMatchObject({ kind: 'error', text: 'Usage: /memories add <text>' })
      expect(await command('add write concisely')).toMatchObject({ text: 'Memory saved locally.' })
      expect(await command('add sk-12345678901234567890')).toMatchObject({ text: 'Memory saved locally with a secret-like value redacted.' })
      expect((await command('list'))?.text).toContain('write concisely')
      const entries = await ctx.localMemories.list()
      expect(agent.session.events.filter(event => event.type === 'memory/accepted')).toHaveLength(2)
      expect(await command(`remove ${entries[0]!.id}`)).toMatchObject({ text: 'Memory removed.' })
      expect(await command('remove missing')).toMatchObject({ kind: 'error', text: 'Memory id not found.' })
      for (const input of ['remove', 'save invalid', 'unknown']) {
        const result = await command(input)
        expect(result?.kind).toBe('error')
        expect(result?.text).toContain('Usage:')
      }
      await ctx.settings.update(settingsNamespace('memory'), { enabled: false })
      expect(await command('add disabled')).toMatchObject({ kind: 'error', text: 'Memory saving is off for this chat.' })
    } finally {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.HYDRA_HOME
      else process.env.HYDRA_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

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
    const home = await mkdtemp(join(tmpdir(), 'hydra-memory-loop-'))
    const previousHome = process.env.HYDRA_HOME
    process.env.HYDRA_HOME = home
    try {
      const adapter = new ScriptedAdapter([textResponse('ack')])
      const ctx = await loopHarness(adapter, { memory: { enabled: true, useMemories: true, generateMemories: true } })
      await ctx.get('localMemories')!.add('User prefers concise Vietnamese answers')
      const agent = ctx.agentLoop.create(SessionId('memory-enabled'), { provider: 'mock', model: 'mock' })

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('User prefers concise Vietnamese answers')
      expect(adapter.requests[0]!.messages.filter(message => message.source.kind === 'plugin' && message.source.plugin === '@hydra1902/harness-personalization')).toHaveLength(1)
      expect(resolveMemoryPolicy(agent.session)).toEqual({ useMemories: true, generateMemories: true })
      await ctx.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.HYDRA_HOME
      else process.env.HYDRA_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not recall memories when the global switch is off', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hydra-memory-off-'))
    const previousHome = process.env.HYDRA_HOME
    process.env.HYDRA_HOME = home
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
      if (previousHome === undefined) delete process.env.HYDRA_HOME
      else process.env.HYDRA_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
})
