import { describe, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import type { Agent } from '@hydraharness/harness-agent'
import Sessions, { SessionId } from '@hydraharness/harness-session'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import ToolRuntime, { defineTool } from '@hydraharness/harness-tools'
import { CallId } from '@hydraharness/harness-llm'
import InvariantRegistry from '@hydraharness/harness-invariants'
import * as Policy from '../src/index.ts'
import * as PolicyInvariant from '../src/invariant.ts'

describe('shared research budgets', () => {
  it('charges browser tools, bypasses unrelated or agentless tools, and preserves downstream errors', async () => {
    const ctx = new Context()
    await ctx.plugin(Sessions)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    try {
      const session = ctx.sessions.create(SessionId('browser-budget'))
      for (const name of ['browser_state', 'unrelated', 'web_fetch']) {
        ctx.tools.register(defineTool({ name, description: 'test', parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { return 'ok' },
        }))
      }
      await ctx.plugin(Policy, { maxBrowserCalls: 1, maxDurationMs: 30_000 })
      ctx.on('tools/execute', (execution, next) => {
        if (execution.name === 'web_fetch') throw new Error('provider unavailable')
        return next()
      })
      const call = (name: string, agent?: Agent) => ctx.tools.execute({ name, arguments: {},
        callId: CallId(name), signal: new AbortController().signal, ...agent === undefined ? {} : { agent } })
      const agent = { id: session.id, session } as Agent
      expect((await call('unrelated', agent)).isError).toBe(false)
      expect((await call('browser_state')).isError).toBe(false)
      expect(session.events.filter(event => event.type === 'research/charge')).toHaveLength(0)
      expect((await call('browser_state', agent)).isError).toBe(false)
      expect((await call('browser_state', agent)).error?.info?.code).toBe('RESEARCH_BUDGET_EXHAUSTED')
      expect(JSON.stringify(await call('web_fetch', agent))).toContain('provider unavailable')
      expect(session.events.filter(event => event.type === 'research/charge').map(event => event.data.kind))
        .toEqual(['browser', 'fetch'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports corrupt research accounting records and accepts unrelated session events', async () => {
    const ctx = new Context()
    await ctx.plugin(Sessions)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(PolicyInvariant)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const session = ctx.sessions.create(SessionId('accounting'))
      session.append('sandbox/mode', { mode: 'read-only' })
      for (const [kind, queries] of [['search', -1], ['search', 0.5], ['fetch', 1], ['browser', 2]] as const) {
        session.append('research/charge', { owner: session.id, kind, queries })
      }
      expect(() => session.append('research/charge', { owner: session.id, kind: 'search', queries: 2 })).not.toThrow()
      expect(() => session.append('research/charge', { owner: session.id, kind: 'fetch', queries: 0 })).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(4)
      expect(warn.mock.calls.every(call => String(call[0]).includes('invalid query units'))).toBe(true)
    } finally {
      warn.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('charges concurrent children and retains the charge through policy reload and root resume', async () => {
    const ctx = new Context()
    await ctx.plugin(Sessions)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const root = ctx.sessions.create(SessionId('root'))
    const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: root.id, origin: 'subagent' } })
    const grandchild = ctx.sessions.create(SessionId('grandchild'), { meta: { parentSession: child.id, origin: 'subagent' } })
    let calls = 0
    ctx.tools.register(defineTool({ name: 'web_search', description: 'test', parameters: { queries: { type: 'array', items: { type: 'string' }, required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { calls++; return 'source' },
    }))
    const call = (session: typeof root) => ctx.tools.execute({ name: 'web_search', arguments: { queries: ['a', 'a', 'b'] },
      callId: CallId('call-' + session.id), signal: new AbortController().signal, agent: { id: session.id, session } as Agent })
    const fiber = await ctx.plugin(Policy, { maxSearchCalls: 1, maxQueries: 2 })
    const results = await Promise.all([call(child), call(grandchild)])
    expect(results.map(result => result.isError)).toEqual([false, true])
    expect(calls).toBe(1)
    expect(root.events.filter(event => event.type === 'research/charge').map(event => event.data.queries)).toEqual([2])
    await fiber.dispose()
    await ctx.plugin(Policy, { maxSearchCalls: 1 })
    expect((await call(child)).error?.info?.code).toBe('RESEARCH_BUDGET_EXHAUSTED')
    const resumed = ctx.sessions.create(SessionId('resumed'), { seed: root.events })
    expect((await call(resumed)).error?.info?.code).toBe('RESEARCH_BUDGET_EXHAUSTED')
  })

  it('rejects invalid limits at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Sessions)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Policy, { maxQueries: 0 })).rejects.toThrow('positive integers')
  })

  it('reports its own elapsed deadline when a cooperative provider rejects cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(Sessions)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const session = ctx.sessions.create(SessionId('timed'))
    ctx.tools.register(defineTool({ name: 'web_fetch', description: 'test', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute(_args, execution): Promise<string> {
        return new Promise((_resolve, reject) => {
          execution.signal.addEventListener('abort', () => { reject(new Error('provider aborted')) }, { once: true })
        })
      },
    }))
    await ctx.plugin(Policy, { maxDurationMs: 30 })
    const result = await ctx.tools.execute({ name: 'web_fetch', arguments: {}, callId: CallId('timed'),
      signal: new AbortController().signal, agent: { id: session.id, session } as Agent })
    expect(result.error?.info?.code).toBe('RESEARCH_BUDGET_EXHAUSTED')
    expect(session.events.filter(event => event.type === 'research/charge')).toHaveLength(1)
  })
})
