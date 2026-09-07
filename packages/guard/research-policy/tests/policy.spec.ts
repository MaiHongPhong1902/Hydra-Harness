import { describe, expect, it } from 'vitest'
import { Context } from '@hydra/cordis'
import type { Agent } from '@hydra/harness-agent'
import Sessions, { SessionId } from '@hydra/harness-session'
import SystemPrompt from '@hydra/harness-system-prompt'
import ToolRuntime, { defineTool } from '@hydra/harness-tools'
import { CallId } from '@hydra/harness-llm'
import * as Policy from '../src/index.ts'

describe('shared research budgets', () => {
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
