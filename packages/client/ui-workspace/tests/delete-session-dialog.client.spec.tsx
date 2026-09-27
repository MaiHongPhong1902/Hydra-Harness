// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@hydra1902/harness-client-runtime/client'
import { DeleteSessionDialog } from '../src/client/DeleteSessionDialog.tsx'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const target = { id: 'delete-target' as SessionId, title: 'Saved conversation' }
const t: WorkspaceBrowserProps['t'] = (key, params) => {
  let text = ({ cancel: 'Cancel', close: 'Close', ...en } as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

function mount(deleteSession = vi.fn<(id: SessionId) => Promise<void>>().mockResolvedValue(undefined)) {
  const onClose = vi.fn()
  render(<DeleteSessionDialog targets={[target]} deleteSession={deleteSession} onClose={onClose} t={t} />)
  return { deleteSession, onClose }
}

describe('DeleteSessionDialog', () => {
  it('renders a bulk dialog with no targets without inventing a title', () => {
    const onClose = vi.fn()
    render(<DeleteSessionDialog targets={[]} deleteSession={vi.fn(async () => {})} onClose={onClose} t={t} />)
    expect(screen.getByRole('dialog').textContent).toContain('Delete session')
  })

  it.each(['Cancel', 'Close'])('dismisses with %s without deleting', (name) => {
    const { deleteSession, onClose } = mount()
    expect(screen.getByRole('dialog').textContent).toContain(target.title)
    fireEvent.click(screen.getByRole('button', { name }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('holds dismissal and repeated confirmation until deletion settles', async () => {
    let finish!: () => void
    const deleteSession = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const { onClose } = mount(deleteSession)
    const button = screen.getByRole('button', { name: 'Delete session' })
    fireEvent.click(button)
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(target.id)
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.textContent).toBe(t('delete.session.pending'))
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(deleteSession).toHaveBeenCalledOnce()
    await act(async () => { finish() })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each([new Error('storage unavailable'), 'storage unavailable'])(
    'retains a rejected deletion for retry: %s',
    async (reason) => {
      const deleteSession = vi.fn<(id: SessionId) => Promise<void>>()
        .mockRejectedValueOnce(reason).mockResolvedValue(undefined)
      const { onClose } = mount(deleteSession)
      fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
      expect((await screen.findByRole('alert')).textContent).toBe('storage unavailable')
      expect(onClose).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
      await waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(deleteSession).toHaveBeenCalledTimes(2)
    },
  )

  it('retains only failed sessions when a bulk deletion partially fails', async () => {
    const second = { id: 'delete-target-2' as SessionId, title: 'Another conversation' }
    const deleteSession = vi.fn<(id: SessionId) => Promise<void>>()
      .mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(<DeleteSessionDialog targets={[target, second]} deleteSession={deleteSession} onClose={onClose} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected sessions (2)' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Saved conversation: storage unavailable')
    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual([target.id, second.id])
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected sessions (1)' }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
    expect(deleteSession).toHaveBeenCalledTimes(3)
  })
})
