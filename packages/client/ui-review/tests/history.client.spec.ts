import { describe, expect, it, vi } from 'vitest'
import { ReviewHistory } from '../src/client/history.ts'
import { change, ok } from './fixture.ts'
import type { IApiClient } from '@hydra/harness-api-remotes/client'
import type { WorkspaceReview } from '@hydra/harness-fs-review/client'

function bench() {
  const api = {
    list: vi.fn(async () => ok({ changes: [change()] })),
    keep: vi.fn(async () => ok({ status: 'kept' as const, change: change({ state: 'kept' }) })),
    undo: vi.fn(async () => ok({ status: 'conflict' as const, change: change() })),
  }
  return { api, history: new ReviewHistory('owner' as never, api) }
}

describe('shared review history', () => {
  it('keeps the latest comparison when requests finish out of order and refreshes it after host changes', async () => {
    const { api } = bench()
    const older = Promise.withResolvers<Awaited<ReturnType<IApiClient['review']['workspace']>>>()
    const value: WorkspaceReview = {
      workspace: '/workspace', repository: '/workspace', branch: 'topic', branches: [], commits: [],
      mode: 'staged', baseRef: null, files: [], truncated: false,
    }
    const workspace = vi.fn<IApiClient['review']['workspace']>(async () => ok(value))
    workspace.mockReturnValueOnce(older.promise)
    const history = new ReviewHistory('owner' as never, { ...api, workspace })
    const read = history.refreshWorkspace('unstaged')
    await history.refreshWorkspace('staged')
    older.resolve(ok({ ...value, mode: 'unstaged' }))
    await read
    expect(history.getSnapshot().workspace?.mode).toBe('staged')
    const unsubscribe = history.subscribe(vi.fn())
    await history.refresh()
    expect(workspace).toHaveBeenLastCalledWith({ sessionId: 'owner', mode: 'staged', fullContext: false })
    workspace.mockRejectedValueOnce(new Error('Git unavailable'))
    await history.refreshWorkspace()
    expect(history.getSnapshot()).toMatchObject({ workspaceError: 'Git unavailable', error: null, changes: [change()] })
    unsubscribe()
    history.dispose()
    const calls = workspace.mock.calls.length
    await history.refreshWorkspace()
    expect(workspace).toHaveBeenCalledTimes(calls)
  })
  it('surfaces wire failures and unavailable snapshots, and ignores a read settled after disposal', async () => {
    const failure = { rpcId: 'rpc' as never, result: { ok: false as const, error: { code: 'internal' as const, message: 'disk unavailable', details: {} } } }
    const api = {
      list: vi.fn<IApiClient['review']['list']>(async () => failure),
      keep: vi.fn<IApiClient['review']['keep']>(async () => failure),
      undo: vi.fn<IApiClient['review']['undo']>(async () => ok({ status: 'unavailable' as const, change: change() })),
    }
    const history = new ReviewHistory('owner' as never, api)
    await history.refresh()
    expect(history.getSnapshot().error).toBe('disk unavailable')
    vi.mocked(api.list).mockRejectedValueOnce('disconnected')
    await history.refresh()
    expect(history.getSnapshot().error).toBe('disconnected')
    vi.mocked(api.list).mockResolvedValue(ok({ changes: [change()] }))
    await history.refresh()
    const unsubscribe = history.subscribe(vi.fn())
    await history.act(change(), 'keep')
    expect(history.getSnapshot().error).toBe('disk unavailable')
    vi.mocked(api.keep).mockRejectedValueOnce('offline')
    await history.act(change(), 'keep')
    expect(history.getSnapshot().error).toBe('offline')
    await history.act(change(), 'undo')
    expect(history.getSnapshot().error).toContain('Undo is unavailable')
    const pending = Promise.withResolvers<Awaited<ReturnType<IApiClient['review']['list']>>>()
    vi.mocked(api.list).mockReturnValueOnce(pending.promise)
    const read = history.refresh()
    const last = history.getSnapshot()
    unsubscribe()
    history.dispose()
    pending.resolve(ok({ changes: [] }))
    await read
    expect(history.getSnapshot()).toBe(last)
  })
  it('coalesces overlapping reads, retries errors and stops publication on disposal', async () => {
    const { api, history } = bench()
    const notified = vi.fn()
    const initial = history.getSnapshot()
    expect(history.getSnapshot()).toBe(initial)
    const unsubscribe = history.subscribe(notified)
    await Promise.all([history.refresh(), history.refresh()])
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(history.getSnapshot()).toMatchObject({ loading: false, changes: [change()] })
    api.list.mockRejectedValueOnce(new Error('offline'))
    await history.refresh()
    expect(history.getSnapshot().error).toBe('offline')
    await history.refresh()
    expect(history.getSnapshot().error).toBeNull()
    unsubscribe()
    const last = history.getSnapshot()
    history.dispose()
    await history.refresh()
    expect(history.getSnapshot()).toBe(last)
  })

  it('deduplicates actions, preserves conflicts after refresh and uses the exact child owner', async () => {
    const { api, history } = bench()
    const child = change({ sessionId: 'child' as never, parentSessionId: 'owner' as never })
    const action = history.act(child, 'undo')
    expect(history.getSnapshot().pending.has(child.id)).toBe(true)
    await history.act(child, 'undo')
    await action
    expect(api.undo).toHaveBeenCalledExactlyOnceWith({ sessionId: 'child', changeId: child.id })
    expect(history.getSnapshot().error).toContain('file changed')
    expect(history.getSnapshot().pending.size).toBe(0)
    await history.act(child, 'keep')
    expect(history.getSnapshot().error).toBeNull()
    api.keep.mockRejectedValueOnce(new Error('retry later'))
    await history.act(child, 'keep')
    expect(history.getSnapshot().error).toBe('retry later')
    expect(history.getSnapshot().pending.size).toBe(0)
  })
})
