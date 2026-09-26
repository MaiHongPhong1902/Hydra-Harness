/** Confirmation shared by the sidebar and Archived sessions settings. */
import { useState } from 'react'
import { Button, Modal } from '@hydra/harness-client-ui-primitives'
import type { SessionId } from '@hydra/harness-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

/** Confirm permanent deletions, attempting each session and retaining only failures for retry. */
export function DeleteSessionDialog({ targets, deleteSession, onClose, t }: {
  targets: readonly { id: SessionId; title: string }[]
  deleteSession: (id: SessionId) => Promise<void>
  onClose: () => void
  t: WorkspaceBrowserProps['t']
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [remaining, setRemaining] = useState(targets)
  const multiple = targets.length > 1
  const title = multiple ? t('delete.sessions', { n: remaining.length }) : t('delete.session')
  const firstTarget = targets[0]
  const close = () => { if (!busy) onClose() }
  const confirm = async () => {
    setBusy(true)
    setError(undefined)
    const failed: typeof targets[number][] = []
    const errors: string[] = []
    for (const target of remaining) {
      try {
        await deleteSession(target.id)
      } catch (reason: unknown) {
        failed.push(target)
        const detail = reason instanceof Error ? reason.message : String(reason)
        errors.push(multiple ? `${target.title}: ${detail}` : detail)
      }
    }
    if (failed.length === 0) { onClose(); return }
    setRemaining(failed)
    setError(errors.join('\n'))
    setBusy(false)
  }
  return (
    <Modal open onClose={close} closeLabel={t('close')} title={title}
      description={multiple
        ? t('delete.sessions.desc', { n: remaining.length })
        : t('delete.session.desc', { name: firstTarget?.title ?? '' })}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
        <Button variant="outline" className={css.deleteAction} disabled={busy} onClick={() => { void confirm() }}>
          {busy ? t('delete.session.pending') : title}
        </Button>
      </>}
    >
      {multiple ? <ul>{remaining.map(target => <li key={target.id}>{target.title}</li>)}</ul> : null}
      {error === undefined ? null : <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
