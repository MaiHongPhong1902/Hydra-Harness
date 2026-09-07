import { describe, expect, it } from 'vitest'
import { Context } from '@hydra/cordis'
import type { Agent } from '@hydra/harness-agent'
import Sessions, { SessionId } from '@hydra/harness-session'
import { delegationAdmission, delegationRoot } from '../src/budget.ts'

describe('delegation tree admission', () => {
  it('reserves before asynchronous creation and retains cumulative spend across resume', async () => {
    const ctx = new Context()
    await ctx.plugin(Sessions)
    const root = ctx.sessions.create(SessionId('root'))
    const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: root.id, origin: 'subagent' } })
    const asAgent = (session: typeof root) => ({ session, id: session.id }) as Agent
    const admit = delegationAdmission(ctx, { maxActivePerTree: 1, maxChildrenPerTree: 1 })
    const release = admit(asAgent(root), true)
    expect(() => admit(asAgent(child), true)).toThrow('active child limit')
    release(); release()
    expect(() => admit(asAgent(child), true)).toThrow('creation budget')
    const resumed = ctx.sessions.create(SessionId('resumed'), { seed: root.events })
    expect(() => delegationAdmission(ctx, { maxChildrenPerTree: 1 })(asAgent(resumed), true)).toThrow('creation budget')
    const finishResume = admit(asAgent(child), false)
    finishResume()
    expect(delegationRoot(ctx, asAgent(child))).toBe(root)
  })

  it('refuses missing ancestry instead of resetting the budget', async () => {
    const ctx = new Context()
    await ctx.plugin(Sessions)
    const session = ctx.sessions.create(SessionId('child'), { meta: { parentSession: SessionId('missing'), origin: 'subagent' } })
    expect(() => delegationRoot(ctx, { session } as Agent)).toThrow('live parent')
  })
})
