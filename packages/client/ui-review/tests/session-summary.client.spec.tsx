// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@hydra/harness-client-runtime/client'
import type { WorkspaceListState } from '@hydra/harness-client-runtime/client'
import type { ReviewSnapshot } from '../src/client/history.ts'
import { SessionSummaryAction } from '../src/client/SessionSummary.tsx'

afterEach(cleanup)

const sessionId = 'summary-session' as never

const hook = <T,>(value: T) => <S,>(selector: (state: T) => S): S => selector(value)

const session = {
  id: sessionId,
  displayTitle: 'Summary',
  cwd: '/work',
  running: false,
  blank: false,
  updatedAt: 1,
  completed: true,
  agentPreset: 'standard',
}

const workspace = {
  workspaceId: 'workspace' as never,
  path: '/work',
  title: 'Work',
  sessionIds: [sessionId],
  createdAt: '',
  updatedAt: '',
}

const file = (attachmentId: string, name: string) => ({
  type: 'file', attachment: { attachmentId, name, bytes: 1 },
})

const nodes = [{
  kind: 'user',
  content: [
    file('a', 'session.jsonl'),
    file('b', 'session.jsonl'),
    file('c', 'notes.md'),
    file('d', 'design.md'),
    file('e', 'report.md'),
  ],
}]

const gitFiles = [
  { path: 'src/one.ts', status: 'modified' as const, additions: 4, deletions: 2, hunks: [], binary: false, truncated: false, patch: null },
  { path: 'src/two.ts', status: 'added' as const, additions: 1, deletions: 0, hunks: [], binary: false, truncated: false, patch: null },
]

const baseReview: ReviewSnapshot = {
  changes: [{
    version: 1,
    id: 'change' as never,
    sessionId,
    callId: 'call' as never,
    rootCallId: 'call' as never,
    toolName: 'edit',
    seq: 1,
    turnSeq: null,
    stepSeq: null,
    parentSessionId: null,
    agentPreset: null,
    createdAt: 1,
    workspace: '/work',
    path: 'src/App.tsx',
    operation: 'edit',
    status: 'modified' as const,
    state: 'active',
    beforeHash: null,
    afterHash: null,
    reversible: false,
    binary: false,
    truncated: false,
    additions: 2,
    deletions: 1,
    hunks: [],
  }],
  pending: new Set(),
  loading: false,
  error: null,
  workspace: {
    workspace: '/work',
    repository: '/work/.git',
    branch: 'main',
    branches: ['main'],
    commits: [{ oid: 'abcdef123456', subject: 'Initial' }],
    mode: 'uncommitted',
    baseRef: null,
    files: gitFiles,
    truncated: false,
  },
  workspaceLoading: false,
  workspaceError: null,
}

const host = {
  version: 'Hydra 1',
  cwd: '/work',
  provider: 'deepseek',
  model: 'deepseek-chat',
  attachedSessions: 1,
  home: '/home',
  canOpenPath: true,
}

type RenderOptions = {
  review?: ReviewSnapshot
  historyNodes?: typeof nodes
  hasMore?: boolean
  hostDescription?: unknown
  sessionValue?: unknown
}

function renderSummary(options: RenderOptions = {}) {
  const {
    review = baseReview,
    historyNodes = nodes,
    hasMore = true,
    sessionValue = session,
  } = options
  const hostDescription = 'hostDescription' in options ? options.hostDescription : host
  const refreshWorkspace = vi.fn()
  const sessions = { byId: { [sessionId]: sessionValue } } as unknown as SessionListState
  const workspaces = { items: [workspace] } as unknown as WorkspaceListState
  const props = {
    sessionId,
    useSession: hook({ chat: { legacy: { nodes: historyNodes } }, hasMore }),
    useSessions: hook(sessions),
    useWorkspaces: hook(workspaces),
    useReview: hook(review),
    refreshWorkspace,
    useHostDescription: <T,>(selector: (description: unknown) => T) => selector(hostDescription),
  } as unknown as ComponentProps<typeof SessionSummaryAction>
  const ui = render(<SessionSummaryAction {...props} />)
  const trigger = screen.getByRole('button', { name: 'Session summary' })
  return { ui, trigger, refreshWorkspace }
}

function openSummary() {
  const trigger = screen.getByRole('button', { name: 'Session summary' })
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: 'Session summary' })
  return { dialog, trigger }
}

describe('SessionSummaryAction', () => {
  it('opens an anchored overview and expands changes, local details, Git, and sources', () => {
    const { refreshWorkspace } = renderSummary()
    const { dialog, trigger } = openSummary()

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull()
    expect(within(dialog).getByRole('heading', { name: 'Environment' })).toBeTruthy()
    expect(refreshWorkspace).toHaveBeenCalledWith()

    const changes = within(dialog).getByRole('button', { name: 'Changes' })
    expect(changes.getAttribute('aria-expanded')).toBe('false')
    expect(changes.textContent).toContain('+5')
    expect(changes.textContent).toMatch(/(?:−|-)2/u)
    fireEvent.click(changes)
    expect(changes.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.textContent).toContain('Files')
    expect(dialog.textContent).toContain('Session edits')

    const local = within(dialog).getByRole('button', { name: 'Local' })
    expect(local.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(local)
    expect(local.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.textContent).toContain(String(sessionId))
    expect(dialog.textContent).toContain('standard')
    expect(dialog.textContent).toContain('Hydra 1')
    expect(dialog.textContent).toContain('deepseek-chat')

    const branch = within(dialog).getByRole('button', { name: 'main' })
    expect(branch.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(branch)
    expect(branch.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.textContent).toContain('/work/.git')
    expect(dialog.textContent).toContain('Initial')

    expect(within(dialog).getAllByText('session.jsonl', { exact: true })).toHaveLength(2)
    expect(within(dialog).getByText('notes.md', { exact: true })).toBeTruthy()
    expect(within(dialog).queryByText('design.md', { exact: true })).toBeNull()
    const showAll = within(dialog).getByRole('button', { name: 'View all (5)' })
    fireEvent.click(showAll)
    expect(within(dialog).getByText('design.md', { exact: true })).toBeTruthy()
    expect(within(dialog).getByText('report.md', { exact: true })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /View all/u })).toBeNull()
    expect(dialog.textContent).toContain('Only loaded messages are included.')

    expect(within(dialog).getByRole('button', { name: 'Commit or push' }).disabled).toBe(true)
    expect(within(dialog).getByRole('button', { name: 'Create pull request' }).disabled).toBe(true)
  })

  it('keeps loading, errors, and absent workspace data distinguishable', () => {
    const loading: ReviewSnapshot = {
      ...baseReview,
      workspace: null,
      loading: true,
      workspaceLoading: true,
    }
    renderSummary({ review: loading, historyNodes: [], hasMore: false, hostDescription: undefined })
    const loadingDialog = openSummary().dialog
    expect(loadingDialog.textContent).toContain('Loading')
    expect(within(loadingDialog).getByRole('button', { name: 'Loading branch…' })).toBeTruthy()
    const loadingLocal = within(loadingDialog).getByRole('button', { name: 'Local' })
    fireEvent.click(loadingLocal)
    expect(loadingDialog.textContent).toContain('Unavailable')

    cleanup()
    const failed: ReviewSnapshot = {
      ...baseReview,
      workspace: null,
      loading: false,
      workspaceLoading: false,
      error: 'Review unavailable',
      workspaceError: 'Workspace unavailable',
    }
    renderSummary({ review: failed, historyNodes: [], hasMore: false, hostDescription: undefined })
    const errorDialog = openSummary().dialog
    fireEvent.click(within(errorDialog).getByRole('button', { name: 'Changes' }))
    expect(errorDialog.textContent).toContain('Workspace unavailable')
    expect(errorDialog.textContent).not.toContain('Loading changes')

    cleanup()
    const empty: ReviewSnapshot = {
      ...baseReview,
      changes: [],
      workspace: null,
      loading: false,
      workspaceLoading: false,
      error: null,
      workspaceError: null,
    }
    renderSummary({ review: empty, historyNodes: [], hasMore: false, hostDescription: undefined })
    const emptyDialog = openSummary().dialog
    expect(emptyDialog.textContent).not.toContain('Loading')
    expect(within(emptyDialog).getByText('No attached sources', { exact: true })).toBeTruthy()
    expect(within(emptyDialog).queryByRole('status')).toBeNull()
  })

  it('closes from the trigger, outside pointer, or Escape and restores trigger focus', () => {
    const { trigger } = renderSummary({ historyNodes: [], hasMore: false })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Session summary' })).toBeTruthy()
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog', { name: 'Session summary' })).toBeNull()

    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Session summary' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Session summary' })).toBeNull()

    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Session summary' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses the bound host selector when the host description is unavailable', () => {
    renderSummary({ historyNodes: [], hasMore: false, hostDescription: undefined })
    const { dialog } = openSummary()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Local' }))
    expect(dialog.textContent).toContain('Unavailable')
    expect(dialog.textContent).not.toContain('deepseek-chat')
  })
})
