// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReviewChange } from '@hydra/harness-fs-review/client'
import { bindSnapshotSelector } from '@hydra/harness-client-test-runtime'
import { ChangeRow, InlineReview, ReviewPanel } from '../src/client/Review.tsx'
import { ReviewHistory } from '../src/client/history.ts'
import { change, ok } from './fixture.ts'

afterEach(cleanup)

describe('review evidence and actions', () => {
  it('counts sequential changes to one file once and surfaces inline read errors', async () => {
    const list = vi.fn(async () => ok({ changes: [change(), change({ id: 'second' as never })] }))
    const history = new ReviewHistory('owner' as never, { list, keep: vi.fn(), undo: vi.fn() })
    await history.refresh()
    const injected = { ownerSessionId: 'owner', useReview: bindSnapshotSelector(history), act: history.act, refresh: history.refresh }
    const ui = render(<ReviewPanel {...injected as Parameters<typeof ReviewPanel>[0]} />)
    expect(ui.getByText('2 changes · 1 file')).toBeTruthy()
    ui.unmount()
    list.mockRejectedValueOnce(new Error('History is unavailable'))
    await history.refresh()
    const inline = render(<InlineReview {...injected as Parameters<typeof InlineReview>[0]} callId="unmatched" />)
    expect(inline.getByRole('alert').textContent).toBe('History is unavailable')
    history.dispose()
  })
  it('shows loading and empty history, refreshes, and hides unrelated inline calls', async () => {
    const list = vi.fn(async () => ok({ changes: [] as ReviewChange[] }))
    const history = new ReviewHistory('owner' as never, { list, keep: vi.fn(), undo: vi.fn() })
    const injected = { ownerSessionId: 'owner', useReview: bindSnapshotSelector(history), act: history.act, refresh: history.refresh }
    const ui = render(<ReviewPanel {...injected as Parameters<typeof ReviewPanel>[0]} />)
    expect(ui.getByRole('status').textContent).toBe('Loading changes…')
    expect(await ui.findByText('No agent file changes in this session.')).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: 'Refresh' }))
    await history.refresh()
    expect(list.mock.calls.length).toBeGreaterThan(1)
    list.mockResolvedValueOnce(ok({ changes: [change()] }))
    await act(() => history.refresh())
    expect(ui.getByText('1 changes · 1 file')).toBeTruthy()
    ui.unmount()
    const inline = render(<InlineReview {...injected as Parameters<typeof InlineReview>[0]} callId="missing" />)
    expect(inline.container.textContent).toBe('')
    history.dispose()
  })

  it('keeps a change, shows pending work and distinguishes limited, empty and contextual diffs', () => {
    const act = vi.fn()
    const record = change({ hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [' context', '-A', '+B'] }] })
    const ui = render(<ChangeRow change={record} pending={false} act={act} />)
    fireEvent.click(ui.getByRole('button', { name: 'Keep' }))
    expect(act).toHaveBeenCalledWith(record, 'keep')
    fireEvent.click(ui.getByText('a.txt'))
    expect(ui.getByLabelText('Recorded diff for a.txt').textContent).toContain(' context\n-A\n+B')
    ui.rerender(<ChangeRow change={change({ truncated: true })} pending={true} act={act} />)
    expect(ui.getByText('Diff exceeds the preview limit.')).toBeTruthy()
    expect(ui.getByRole('status').textContent).toBe('Saving…')
    for (const button of ui.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
    ui.rerender(<ChangeRow change={change({ hunks: [] })} pending={false} act={act} />)
    expect(ui.getByText('No line changes.')).toBeTruthy()
  })
  it('shows persisted diff and runtime attribution; Keep retains Undo', () => {
    const act = vi.fn()
    const record = change({ state: 'kept', parentSessionId: 'parent' as never, agentPreset: 'parser-refactor' })
    const ui = render(<ChangeRow change={record} pending={false} act={act} />)
    fireEvent.click(ui.getByText('a.txt'))
    expect(ui.getByText(/parser-refactor/)).toBeTruthy()
    expect(ui.getByLabelText('Recorded diff for a.txt').textContent).toContain('-A\n+B')
    expect((ui.getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(ui.getByRole('button', { name: 'Undo' }))
    expect(act).toHaveBeenCalledWith(record, 'undo')
  })

  it.each(['pending', 'undoing', 'rolledBack'] as const)('prevents actions for %s evidence', (state) => {
    const ui = render(<ChangeRow change={change({ state })} pending={false} act={vi.fn()} />)
    for (const button of ui.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers no Undo for oversized snapshots and explains binary previews', () => {
    const ui = render(<ChangeRow change={change({ reversible: false, binary: true })} pending={false} act={vi.fn()} />)
    fireEvent.click(ui.getByText('a.txt'))
    expect(ui.getByText('Binary file — text diff unavailable.')).toBeTruthy()
    expect((ui.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('counts history, reports conflicts and keeps child calls out of the parent inline row', async () => {
    const records = [change(), change({ id: 'other' as never, sessionId: 'child' as never, path: 'child.txt' })]
    const history = new ReviewHistory('owner' as never, {
      list: async () => ok({ changes: records }),
      undo: async () => ok({ status: 'conflict', change: records[0]! }),
      keep: async () => ok({ status: 'kept', change: records[0]! }),
    })
    await history.refresh()
    await history.act(records[0]!, 'undo')
    const injected = {
      ownerSessionId: records[0]!.sessionId, useReview: bindSnapshotSelector(history), act: history.act, refresh: history.refresh,
    }
    const panel = render(<ReviewPanel {...injected as Parameters<typeof ReviewPanel>[0]} />)
    expect(panel.getByText('2 changes · 2 files')).toBeTruthy()
    expect(panel.getByRole('alert').textContent).toContain('Undo was skipped')
    panel.unmount()
    const inline = render(<InlineReview {...injected as Parameters<typeof InlineReview>[0]} callId="call" />)
    expect(inline.queryByText('child.txt')).toBeNull()
    expect(inline.getByText('a.txt')).toBeTruthy()
    history.dispose()
  })
})
