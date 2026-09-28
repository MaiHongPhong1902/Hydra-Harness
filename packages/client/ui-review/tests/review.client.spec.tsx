// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ReviewChange, WorkspaceReview } from '@hydraharness/harness-fs-review/client'
import { bindSnapshotSelector } from '@hydraharness/harness-client-test-runtime'
import { ChangeRow, InlineReview, ReviewPanel, sameWorkspace } from '../src/client/Review.tsx'
import { ReviewHistory, type ReviewSnapshot } from '../src/client/history.ts'
import { change, ok } from './fixture.ts'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.useRealTimers()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

function snapshotPanel(overrides: Partial<ReviewSnapshot> = {}) {
  const snapshot: ReviewSnapshot = { changes: [], pending: new Set(), loading: false, error: null,
    workspace: null, workspaceLoading: false, workspaceError: null, ...overrides }
  const props = { ownerSessionId: 'owner', useReview: (select: (value: ReviewSnapshot) => unknown) => select(snapshot),
    act: vi.fn(async () => true), refresh: vi.fn(async () => {}) } as Parameters<typeof ReviewPanel>[0]
  return { ...render(<ReviewPanel {...props} />), snapshot, props }
}

function workspaceReview(files: WorkspaceReview['files'] = []): WorkspaceReview {
  return { workspace: '/workspace', repository: '/workspace', branch: null, branches: [], commits: [],
    mode: 'uncommitted', baseRef: null, truncated: false, files }
}

describe('review evidence and actions', () => {
  it('normalizes Windows drive spelling while retaining POSIX case sensitivity', () => {
    expect(sameWorkspace('C:\\Work\\Project\\', 'c:/work/project')).toBe(true)
    expect(sameWorkspace('/Work/Project', '/work/project')).toBe(false)
  })

  it('renders an inline call without an error and an unavailable workspace comparison', () => {
    const ui = snapshotPanel({ changes: [change()] })
    ui.rerender(<InlineReview {...ui.props as Parameters<typeof InlineReview>[0]} callId="call" />)
    expect(ui.getByRole('region', { name: 'a.txt active' })).toBeTruthy()
    ui.rerender(<ReviewPanel {...ui.props} />)
    fireEvent.change(ui.getByLabelText('Review scope'), { target: { value: 'uncommitted' } })
    expect(ui.getByText('No changes in this comparison.')).toBeTruthy()
  })

  it('copies recorded hunks, resets its status and surfaces clipboard rejection', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const ui = render(<ChangeRow change={change({ status: 'deleted' })} pending={false} act={vi.fn()} />)
    fireEvent.click(ui.getByRole('button', { name: 'Copy diff' }))
    await act(async () => { await Promise.resolve() })
    expect(writeText).toHaveBeenCalledWith('@@ -1,1 +1,1 @@\n-A\n+B')
    expect(ui.getByRole('button', { name: 'Copied!' })).toBeTruthy()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(ui.getByRole('button', { name: 'Copy diff' }))
    await act(async () => { await Promise.resolve() })
    expect(ui.getByRole('alert').textContent).toBe('Clipboard access failed.')
  })

  it('navigates status tabs with arrows, Home and End and preserves unrelated keys', () => {
    const ui = snapshotPanel({ changes: [change({ path: 'a/b/deleted.ts', status: 'deleted', state: 'rolledBack' }),
      change({ id: 'kept' as never, path: 'a/kept.ts', state: 'kept' })] })
    for (const [key, name] of [['End', 'Undone'], ['ArrowLeft', 'Kept'], ['Home', 'All'], ['ArrowLeft', 'Undone']]) {
      fireEvent.keyDown(ui.getByRole('tab', { selected: true }), { key })
      expect(ui.getByRole('tab', { selected: true }).textContent).toContain(name)
    }
    fireEvent.keyDown(ui.getByRole('tab', { selected: true }), { key: 'Escape' })
    expect(ui.getByRole('tab', { selected: true }).textContent).toContain('Undone')
    fireEvent.change(ui.getByRole('searchbox'), { target: { value: 'missing' } })
    expect(ui.getByText('No changes match the selected filters.')).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: 'Toggle view mode' }))
    expect(ui.queryByRole('button', { name: 'Next file' })).toBeNull()
  })

  it('renders workspace binary, truncated and empty previews and disables incomplete patch copy', () => {
    const file = { path: 'src/base.ts', status: 'modified' as const, additions: 0, deletions: 0,
      hunks: [], binary: false, truncated: false, patch: '' }
    const ui = snapshotPanel({ workspace: workspaceReview([
      { ...file, path: 'src/binary', status: 'added', binary: true, patch: null },
      { ...file, path: 'src/large', status: 'deleted', truncated: true }, file,
    ]) })
    fireEvent.change(ui.getByLabelText('Review scope'), { target: { value: 'staged' } })
    fireEvent.click(ui.getByRole('button', { name: 'Expand all diffs' }))
    expect(ui.getByText('Binary file — text diff unavailable.')).toBeTruthy()
    expect(ui.getByText('Diff exceeds the preview limit.')).toBeTruthy()
    expect(ui.getByText('No line changes.')).toBeTruthy()
    expect(ui.getByRole('button', { name: 'Copy patch' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(ui.getByRole('button', { name: 'Collapse all diffs' }))
    expect([...ui.container.querySelectorAll('details')].every(node => !node.open)).toBe(true)
    fireEvent.click(ui.getByText('Diff preferences'))
    for (const name of ['Word diffs', 'Hide whitespace changes', 'Full file context']) {
      fireEvent.click(ui.getByRole('checkbox', { name }))
    }
    expect(ui.getByRole('checkbox', { name: 'Full file context' }).matches(':checked')).toBe(true)
  })

  it.each(['loading', 'error', 'non-git', 'empty', 'limited'] as const)('explains the %s workspace comparison', (kind) => {
    const ui = snapshotPanel({ workspaceLoading: kind === 'loading', workspaceError: kind === 'error' ? 'Git failed' : null,
      workspace: { ...workspaceReview(), repository: kind === 'non-git' ? null : '/workspace', truncated: kind === 'limited' } })
    fireEvent.change(ui.getByLabelText('Review scope'), { target: { value: 'branch' } })
    expect(ui.container.textContent).toContain({ loading: 'Loading changes…', error: 'Git failed',
      'non-git': 'not a Git repository', empty: 'No changes in this comparison', limited: 'Showing a limited number of files' }[kind])
    fireEvent.change(ui.getByLabelText('Review scope'), { target: { value: 'committed' } })
    expect(ui.getByLabelText('Commit')).toBeTruthy()
  })

  it.each([false, true])('copies the selected workspace patch and reports clipboard failure (%s)', async (reject) => {
    const writeText = vi.fn(async () => { if (reject) throw new Error('denied') })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const ui = snapshotPanel({ workspace: workspaceReview([{ path: 'a', status: 'added', additions: 1, deletions: 0,
      hunks: change().hunks, binary: false, truncated: false, patch: '+A\n' }]) })
    fireEvent.change(ui.getByLabelText('Review scope'), { target: { value: 'uncommitted' } })
    fireEvent.click(ui.getByRole('button', { name: 'Copy patch' }))
    expect(await ui.findByRole('status')).toHaveProperty('textContent', reject ? 'Clipboard access failed.' : 'Patch copied.')
    expect(writeText).toHaveBeenCalledWith('+A\n')
  })

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

  it('supports batch Keep All and Undo All actions in ReviewPanel', async () => {
    const records = [
      change({ id: 'c1' as never, path: 'src/one.ts', state: 'active', reversible: true }),
      change({ id: 'c2' as never, path: 'src/two.ts', state: 'active', reversible: true }),
    ]
    const keepFn = vi.fn(async () => ok({ status: 'kept' as const, change: records[0]! }))
    const undoFn = vi.fn(async () => ok({ status: 'rolledBack' as const, change: records[0]! }))
    const history = new ReviewHistory('owner' as never, {
      list: async () => ok({ changes: records }),
      keep: keepFn,
      undo: undoFn,
    })
    await history.refresh()
    const injected = {
      ownerSessionId: 'owner',
      useReview: bindSnapshotSelector(history),
      act: history.act,
      refresh: history.refresh,
    }
    const panel = render(<ReviewPanel {...injected as Parameters<typeof ReviewPanel>[0]} />)
    expect(panel.getByRole('button', { name: 'Keep All' })).toBeTruthy()
    expect(panel.getByRole('button', { name: 'Undo All' })).toBeTruthy()

    fireEvent.click(panel.getByRole('button', { name: 'Keep All' }))
    await act(async () => { await Promise.resolve() })
    expect(keepFn).toHaveBeenCalled()

    fireEvent.click(panel.getByRole('button', { name: 'Undo All' }))
    await act(async () => { await Promise.resolve() })
    expect(undoFn).toHaveBeenCalled()
    panel.unmount()
    history.dispose()
  })

  it('filters changes by search input and status tabs', async () => {
    const records = [
      change({ id: 'c1' as never, path: 'src/app.ts', state: 'active', status: 'modified' }),
      change({ id: 'c2' as never, path: 'docs/readme.md', state: 'kept', status: 'added' }),
    ]
    const history = new ReviewHistory('owner' as never, {
      list: async () => ok({ changes: records }),
      keep: vi.fn(),
      undo: vi.fn(),
    })
    await history.refresh()
    const injected = {
      ownerSessionId: 'owner',
      useReview: bindSnapshotSelector(history),
      act: history.act,
      refresh: history.refresh,
    }
    const panel = render(<ReviewPanel {...injected as Parameters<typeof ReviewPanel>[0]} />)
    expect(panel.getByText('src/app.ts')).toBeTruthy()
    expect(panel.getByText('docs/readme.md')).toBeTruthy()

    // Search filter
    const searchInput = panel.getByLabelText('Filter changes by file')
    fireEvent.change(searchInput, { target: { value: 'app' } })
    expect(panel.getByText('src/app.ts')).toBeTruthy()
    expect(panel.queryByText('docs/readme.md')).toBeNull()

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } })
    expect(panel.getByText('docs/readme.md')).toBeTruthy()

    // Filter tabs
    fireEvent.click(panel.getByRole('tab', { name: /Kept/ }))
    expect(panel.queryByText('src/app.ts')).toBeNull()
    expect(panel.getByText('docs/readme.md')).toBeTruthy()

    fireEvent.click(panel.getByRole('tab', { name: /Pending/ }))
    expect(panel.getByText('src/app.ts')).toBeTruthy()
    expect(panel.queryByText('docs/readme.md')).toBeNull()
    fireEvent.keyDown(panel.getByRole('tab', { name: /Pending/ }), { key: 'ArrowRight' })
    expect(panel.getByRole('tab', { name: /Kept/ }).getAttribute('aria-selected')).toBe('true')

    panel.unmount()
    history.dispose()
  })

  it('stops Undo All on a conflict so later actions cannot clear its error', async () => {
    const records = [change(), change({ id: 'latest' as never })]
    const undo = vi.fn(async () => ok({ status: 'conflict' as const, change: records[1]! }))
    const history = new ReviewHistory('owner' as never, { list: async () => ok({ changes: records }), keep: vi.fn(), undo })
    await history.refresh()
    const panel = render(<ReviewPanel {...{
      ownerSessionId: 'owner', useReview: bindSnapshotSelector(history), act: history.act, refresh: history.refresh,
    } as Parameters<typeof ReviewPanel>[0]} />)
    fireEvent.click(panel.getByRole('button', { name: 'Undo All' }))
    await panel.findByRole('alert')
    expect(undo).toHaveBeenCalledExactlyOnceWith({ sessionId: 'owner', changeId: 'latest' })
    expect(panel.getByRole('alert').textContent).toContain('Undo was skipped')
    panel.unmount()
    history.dispose()
  })

  it('supports hierarchical tree navigation, file pagination, and sidebar toggle', async () => {
    const records = [
      change({ id: 'c1' as never, path: '.agents/notes/architecture/seam.md', state: 'active', status: 'modified' }),
      change({ id: 'c2' as never, path: '.agents/notes/bug-fix/fix.md', state: 'active', status: 'added' }),
    ]
    const history = new ReviewHistory('owner' as never, {
      list: async () => ok({ changes: records }),
      keep: vi.fn(),
      undo: vi.fn(),
    })
    await history.refresh()
    const injected = {
      ownerSessionId: 'owner',
      useReview: bindSnapshotSelector(history),
      act: history.act,
      refresh: history.refresh,
    }
    const panel = render(<ReviewPanel {...injected as Parameters<typeof ReviewPanel>[0]} />)

    // Verify folder hierarchy
    expect(panel.getByText('.agents / notes')).toBeTruthy()
    expect(panel.getByText('architecture')).toBeTruthy()
    expect(panel.getByText('bug-fix')).toBeTruthy()
    expect(panel.getByText('seam.md')).toBeTruthy()
    expect(panel.getByText('fix.md')).toBeTruthy()

    // Test folder collapse
    const folder = panel.getByTitle('.agents / notes')
    fireEvent.click(folder)
    expect(panel.queryByText('seam.md')).toBeNull()
    fireEvent.click(folder)
    expect(panel.getByText('seam.md')).toBeTruthy()

    // Test view mode toggle (switch to single file mode)
    const toggleViewBtn = panel.getByRole('button', { name: 'Toggle view mode' })
    fireEvent.click(toggleViewBtn)
    expect(panel.getByText('Showing one file at a time')).toBeTruthy()

    // Test file navigation (< and >) in single mode
    const nextBtn = panel.getByRole('button', { name: 'Next file' })
    const prevBtn = panel.getByRole('button', { name: 'Previous file' })
    expect((prevBtn as HTMLButtonElement).disabled).toBe(true)
    expect((nextBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(nextBtn)
    expect((nextBtn as HTMLButtonElement).disabled).toBe(true)
    expect((prevBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(prevBtn)
    expect((prevBtn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(nextBtn)

    // Test selecting a file directly from tree
    fireEvent.click(panel.getByText('seam.md'))
    expect((prevBtn as HTMLButtonElement).disabled).toBe(true)

    // Test sidebar toggle
    const toggleSidebarBtn = panel.getByRole('button', { name: 'Toggle file list' })
    fireEvent.click(toggleSidebarBtn)
    expect(panel.queryByRole('tree')).toBeNull()
    fireEvent.click(toggleSidebarBtn)
    expect(panel.getByRole('tree')).toBeTruthy()

    panel.unmount()
    history.dispose()
  })

  it('changes diff preferences and selects live workspace comparisons', async () => {
    const workspace = vi.fn(async ({ mode }: { mode: WorkspaceReview['mode'] }) => ok({
      workspace: '/workspace', repository: '/workspace', branch: 'feature/review', branches: ['refs/heads/main'],
      commits: [{ oid: 'a'.repeat(40), subject: 'Initial commit' }], mode, baseRef: null, truncated: false,
      files: [{ path: 'src/live.ts', status: 'modified' as const, additions: 1, deletions: 1, hunks: change().hunks, binary: false, truncated: false, patch: 'live patch\n' }],
    }))
    const history = new ReviewHistory('owner' as never, {
      list: async () => ok({ changes: [change()] }), keep: vi.fn(), undo: vi.fn(), workspace,
    })
    await history.refresh()
    const injected = { ownerSessionId: 'owner', useReview: bindSnapshotSelector(history), act: history.act, refresh: history.refresh, refreshWorkspace: history.refreshWorkspace }
    const panel = render(<ReviewPanel {...injected as Parameters<typeof ReviewPanel>[0]} />)
    await panel.findByText('feature/review')
    fireEvent.click(panel.getByText('Diff preferences'))
    fireEvent.click(panel.getByRole('checkbox', { name: 'Word wrap' }))
    expect((panel.getByRole('checkbox', { name: 'Word wrap' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.change(panel.getByLabelText('Diff layout'), { target: { value: 'split' } })
    expect(panel.getByLabelText('Recorded diff for a.txt').getAttribute('data-mode')).toBe('split')
    fireEvent.change(panel.getByLabelText('Review scope'), { target: { value: 'unstaged' } })
    await panel.findByText('src/live.ts')
    expect(workspace).toHaveBeenLastCalledWith({ sessionId: 'owner', mode: 'unstaged', fullContext: false })
    expect(panel.queryByRole('button', { name: 'Keep All' })).toBeNull()
    expect(panel.queryByRole('button', { name: 'Undo' })).toBeNull()
    fireEvent.click(within(panel.getByRole('tree')).getByText('live.ts'))
    expect(panel.getByText('Showing one file at a time')).toBeTruthy()
    fireEvent.change(panel.getByLabelText('Review scope'), { target: { value: 'branch' } })
    await act(async () => { await Promise.resolve() })
    fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'refs/heads/main' } })
    await act(async () => { await Promise.resolve() })
    expect(workspace).toHaveBeenLastCalledWith({ sessionId: 'owner', mode: 'branch', ref: 'refs/heads/main', fullContext: false })
    fireEvent.change(panel.getByLabelText('Review scope'), { target: { value: 'committed' } })
    await act(async () => { await Promise.resolve() })
    fireEvent.change(panel.getByLabelText('Commit'), { target: { value: 'a'.repeat(40) } })
    await act(async () => { await Promise.resolve() })
    expect(workspace).toHaveBeenLastCalledWith({ sessionId: 'owner', mode: 'committed', ref: 'a'.repeat(40), fullContext: false })
    panel.unmount()
    history.dispose()
  })

  it('labels the workspace from the mounted session and excludes demo branch names', async () => {
    const history = new ReviewHistory('owner' as never, {
      list: async () => ok({ changes: [change()] }), keep: vi.fn(), undo: vi.fn(),
    })
    await history.refresh()
    const useWorkspaces = (
      select: (state: { items: { workspaceId: string; title: string; path: string; sessionIds: string[] }[] }) => unknown,
    ) => select({ items: [
      { workspaceId: 'workspace-owner', title: 'Project Alpha', path: '/projects/alpha', sessionIds: ['owner'] },
      { workspaceId: 'workspace-other', title: 'Project Beta', path: '/projects/beta', sessionIds: ['other'] },
    ] })
    const injected = { ownerSessionId: 'owner', useReview: bindSnapshotSelector(history), act: history.act, refresh: history.refresh, useWorkspaces }
    const panel = render(<ReviewPanel {...injected as Parameters<typeof ReviewPanel>[0]} />)
    expect(panel.getByText('Project Alpha')).toBeTruthy()
    expect(panel.queryByText('Project Beta')).toBeNull()
    expect(panel.container.textContent).not.toContain('origin/chore/rebrand-bh')
    expect(panel.container.textContent).not.toContain('codex/implement-pi-desktop-change-review')
    panel.unmount()
    history.dispose()
  })

  it('keeps aggregated child evidence in the mounted workspace', async () => {
    const history = new ReviewHistory('owner' as never, {
      list: async () => ok({ changes: [
        change({ id: 'inside' as never, workspace: '/projects/alpha', path: 'inside.ts' }),
        change({ id: 'outside' as never, workspace: '/projects/beta', path: 'outside.ts' }),
      ] }), keep: vi.fn(), undo: vi.fn(),
    })
    await history.refresh()
    const useWorkspaces = (select: (state: { items: { title: string; path: string; sessionIds: string[] }[] }) => unknown) => select({
      items: [{ title: 'Alpha', path: '/projects/alpha', sessionIds: ['owner'] }],
    })
    const panel = render(<ReviewPanel {...{
      ownerSessionId: 'owner', useReview: bindSnapshotSelector(history), act: history.act, refresh: history.refresh, useWorkspaces,
    } as Parameters<typeof ReviewPanel>[0]} />)
    expect(panel.getAllByText('inside.ts').length).toBeGreaterThan(0)
    expect(panel.queryByText('outside.ts')).toBeNull()
    panel.unmount()
    history.dispose()
  })

})
