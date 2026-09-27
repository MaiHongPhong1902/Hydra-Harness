// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  SessionId, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@hydra/harness-client-runtime/client'
import type { ArchivedSessionsSectionProps } from '../src/client/ArchivedSessionsSection.tsx'
import { ArchivedSessionsSection } from '../src/client/ArchivedSessionsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (value: string): SessionId => value as SessionId
const wid = (value: string): WorkspaceId => value as WorkspaceId

function hook<T>(value: T) {
  return <S,>(selector: (state: T) => S): S => selector(value)
}

function sessions(): SessionListState {
  return {
    ids: [sid('s-two'), sid('s-one')],
    byId: {
      [sid('s-one')]: {
        id: sid('s-one'), displayTitle: 'First chat', blank: false, running: false, updatedAt: 1,
      },
      [sid('s-two')]: {
        id: sid('s-two'), displayTitle: 'Second chat', blank: false, running: false, updatedAt: 2,
      },
    },
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function workspaceState(archivedSessionIds: readonly SessionId[]): WorkspaceListState {
  const workspace: WorkspaceView = {
    workspaceId: wid('project'), title: 'Project', path: '/projects/project',
    sessionIds: [sid('s-one'), sid('s-two')], createdAt: '1', updatedAt: '2',
  }
  return {
    items: [workspace], archivedSessionIds, state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: workspace.workspaceId,
  }
}

const t: ArchivedSessionsSectionProps['t'] = (key, params) => {
  let text = (en as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

function mount(
  archivedSessionIds: readonly SessionId[] = [sid('s-two'), sid('s-one')],
  restoreSession = vi.fn<(id: SessionId) => Promise<void>>().mockResolvedValue(undefined),
  overrides: Partial<ArchivedSessionsSectionProps> = {},
) {
  const props = {
    useSessions: hook(sessions()),
    useWorkspaces: hook(workspaceState(archivedSessionIds)),
    restoreSession,
    deleteSession: vi.fn(async () => {}),
    t,
    close: vi.fn(),
    ...overrides,
  } as unknown as ArchivedSessionsSectionProps
  return { ...render(<ArchivedSessionsSection {...props} />), restoreSession, deleteSession: props.deleteSession }
}

describe('ArchivedSessionsSection', () => {
  it('keeps archive order and shows the retained Workspace path', () => {
    mount()
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('Second chat')
    expect(rows[1]?.textContent).toContain('First chat')
    expect(screen.getAllByText('/projects/project')).toHaveLength(2)
  })

  it('restores the selected session and prevents duplicate clicks while pending', async () => {
    let resolve!: () => void
    const restoreSession = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    mount([sid('s-one')], restoreSession)
    const button = screen.getByRole('button', { name: 'Restore session First chat' })
    fireEvent.click(button)
    expect(restoreSession).toHaveBeenCalledWith(sid('s-one'))
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(restoreSession).toHaveBeenCalledOnce()
    resolve()
    await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
  })

  it.each([new Error('session unavailable'), 'session unavailable'])('reports a restore failure and remains usable: %s', async (reason) => {
    const restoreSession = vi.fn(async () => { throw reason })
    mount([sid('s-one')], restoreSession)
    fireEvent.click(screen.getByRole('button', { name: 'Restore session First chat' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not restore session: session unavailable')
    expect(screen.getByRole('button', { name: 'Restore session First chat' }).hasAttribute('disabled')).toBe(false)
  })

  it('shows an empty state when the archive set is empty', () => {
    mount([])
    expect(screen.getByText('No archived sessions')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it.each(['sessions', 'workspaces'])('waits for pending %s before showing archived rows', (pending) => {
    mount(undefined, undefined, {
      useSessions: hook({ ...sessions(), phase: pending === 'sessions' ? 'pending' : 'ready' }),
      useWorkspaces: hook({ ...workspaceState([sid('s-one')]), phase: pending === 'workspaces' ? 'pending' : 'ready' }),
    })
    expect(screen.getByText(t('archive.loading'))).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('keeps unknown archived ids visible and uses session cwd when no workspace remains', () => {
    const state = sessions()
    const id = sid('s-one')
    state.byId[id] = { ...state.byId[id]!, cwd: '/previous/workspace' }
    mount(undefined, undefined, {
      useSessions: hook(state),
      useWorkspaces: hook({ ...workspaceState([id, sid('unknown')]), items: [] }),
    })
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('/previous/workspace')
    expect(rows[1]?.textContent).toContain('unknown')
    expect(screen.getAllByText(t('archive.unknownWorkspace'))).toHaveLength(2)
  })

  it('requires confirmation to delete an archived session and closes the dialog after success', async () => {
    const { deleteSession } = mount([sid('s-one')])
    fireEvent.click(screen.getByRole('button', { name: 'Delete session First chat' }))
    let dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('First chat')
    fireEvent.click(within(dialog).getByRole('button', { name: t('cancel') }))
    expect(deleteSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete session First chat' }))
    dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete session' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(sid('s-one'))
  })

  it('restores the selected archived sessions in archive order', async () => {
    const restoreSession = vi.fn<(id: SessionId) => Promise<void>>().mockResolvedValue(undefined)
    mount(undefined, restoreSession)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select session Second chat' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select session First chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected' }))
    await waitFor(() => { expect(restoreSession).toHaveBeenCalledTimes(2) })
    expect(restoreSession.mock.calls.map(([id]) => id)).toEqual([sid('s-two'), sid('s-one')])
    expect(screen.getByRole('status').textContent).toBe('0 selected')
  })

  it('confirms and deletes multiple selected archived sessions', async () => {
    const deleteSession = vi.fn<(id: SessionId) => Promise<void>>()
    mount(undefined, undefined, { deleteSession })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Second chat')
    expect(dialog.textContent).toContain('First chat')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete selected sessions (2)' }))
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledTimes(2) })
    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual([sid('s-two'), sid('s-one')])
  })

  it('clears and prunes selected rows when the archive changes', () => {
    const props = {
      useSessions: hook(sessions()),
      useWorkspaces: hook(workspaceState([sid('s-one'), sid('s-two')])),
      restoreSession: vi.fn<(id: SessionId) => Promise<void>>().mockResolvedValue(undefined),
      deleteSession: vi.fn<(id: SessionId) => Promise<void>>().mockResolvedValue(undefined),
      t,
    } as unknown as ArchivedSessionsSectionProps
    const view = render(<ArchivedSessionsSection {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select session First chat' }))
    fireEvent.click(screen.getByRole('button', { name: t('archive.clearSelection') }))
    expect(screen.getByRole('status').textContent).toBe('0 selected')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select session First chat' }))
    view.rerender(<ArchivedSessionsSection {...props} useWorkspaces={hook(workspaceState([sid('s-two')]))} />)
    expect(screen.getByRole('status').textContent).toBe('0 selected')
  })

  it('removes a row from selection when its checkbox is unchecked', () => {
    mount([sid('s-one')])
    const checkbox = screen.getByRole('checkbox', { name: 'Select session First chat' })
    fireEvent.click(checkbox)
    fireEvent.click(checkbox)
    expect(screen.getByRole('status').textContent).toBe('0 selected')
    const all = screen.getByRole('checkbox', { name: 'Select all' })
    fireEvent.click(all)
    fireEvent.click(all)
    expect(screen.getByRole('status').textContent).toBe('0 selected')
  })

  it('retains failed bulk restores for retry and names the failed session', async () => {
    const restoreSession = vi.fn<(id: SessionId) => Promise<void>>()
      .mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined)
    mount(undefined, restoreSession)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not restore session (Second chat): unavailable')
    expect(screen.getByRole('status').textContent).toBe('1 selected')
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected' }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('0 selected') })
    expect(restoreSession.mock.calls.map(([id]) => id)).toEqual([sid('s-two'), sid('s-one'), sid('s-two')])
  })
})
