import { describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import SessionStore, { SessionId } from '@hydra/harness-session'
import type { SessionHeader } from '@hydra/harness-session'
import type { ChangeId, ReviewChange } from '@hydra/harness-fs-review/client'
import { createApiProxy } from '../src/api-proxy.ts'
import { InProcessApiClient } from '../src/fetch/client.ts'
import { toFetchHandler } from '../src/fetch/handler.ts'

const owner = SessionId('owner')
const child = SessionId('child')
const grandchild = SessionId('grandchild')
const fork = SessionId('fork')

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const headers: SessionHeader[] = [
    { id: child, version: 0, createdAt: 1, origin: 'subagent', parentSession: owner },
    { id: grandchild, version: 0, createdAt: 2, origin: 'subagent', parentSession: child },
    { id: fork, version: 0, createdAt: 3, parentSession: owner },
  ]
  ctx.sessions.create(child, { meta: { origin: 'subagent', parentSession: owner } })
  ctx.provide('sessionPersistence', { list: async () => headers } as never)
  ctx.provide('userQuestions', { registerProvider: () => () => {} } as never)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/workspace' })
  return { ctx, api, client: new InProcessApiClient(toFetchHandler(api)) }
}

describe('review gateway', () => {
  it('reads real session lineage through an injected gateway and keeps forks separate', async () => {
    const { ctx, api } = await bench()
    const list = vi.fn(async (sessionId: SessionId): Promise<ReviewChange[]> => [
      {
        version: 1, id: '00000000-0000-4000-8000-000000000001' as ChangeId, sessionId,
        callId: 'call' as never, rootCallId: 'call' as never, toolName: 'write',
        createdAt: sessionId === owner ? 3 : sessionId === child ? 2 : 1,
        seq: 1, turnSeq: null, stepSeq: null, parentSessionId: null, agentPreset: null,
        workspace: '/workspace', path: 'a.txt', operation: 'write', status: 'added', state: 'active',
        beforeHash: null, afterHash: 'a'.repeat(64), reversible: true,
        binary: false, truncated: false, additions: 1, deletions: 0, hunks: [],
      },
    ])
    ctx.provide('fileReview', { list } as never)
    try {
      const response = await api.review.list({ rpcId: 'review' as never, payload: { sessionId: owner, includeChildren: true } })
      expect(response.result).toMatchObject({ ok: true, value: { changes: [
        { sessionId: grandchild }, { sessionId: child }, { sessionId: owner },
      ] } })
      expect(list.mock.calls.map(([id]) => id)).toEqual([owner, child, grandchild])
      list.mockClear()
      await api.review.list({ rpcId: 'review' as never, payload: { sessionId: owner } })
      expect(list).toHaveBeenCalledExactlyOnceWith(owner)
    } finally { await ctx.fiber.dispose() }
  })

  it('reports missing review service and preserves exact action ownership through the carrier', async () => {
    const { ctx, client } = await bench()
    const changeId = '00000000-0000-4000-8000-000000000001' as ChangeId
    try {
      expect((await client.review.list({ sessionId: owner })).result).toEqual({ ok: true, value: { changes: [] } })
      for (const action of ['keep', 'undo'] as const) {
        expect((await client.review[action]({ sessionId: child, changeId })).result).toMatchObject({ ok: false })
      }
      const keep = vi.fn(async () => { throw new Error('wrong owner') })
      const undo = vi.fn(async () => { throw new Error('snapshot corrupt') })
      ctx.provide('fileReview', { keep, undo } as never)
      expect((await client.review.keep({ sessionId: child, changeId })).result)
        .toMatchObject({ ok: false, error: { message: 'wrong owner' } })
      expect((await client.review.undo({ sessionId: child, changeId })).result)
        .toMatchObject({ ok: false, error: { message: 'snapshot corrupt' } })
      expect(keep).toHaveBeenCalledExactlyOnceWith(child, changeId)
      expect(undo).toHaveBeenCalledExactlyOnceWith(child, changeId)
    } finally { await ctx.fiber.dispose() }
  })
})
