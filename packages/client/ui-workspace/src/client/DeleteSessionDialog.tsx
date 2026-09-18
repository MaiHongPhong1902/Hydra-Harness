/** Confirmation shared by the sidebar and Archived sessions settings. */
import { useState } from 'react'
import { Button, Modal } from '@hydra/harness-client-ui-primitives'
import type { SessionId } from '@hydra/harness-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

/** Confirm a permanent session deletion and retain failures for retry. */
export function DeleteSessionDialog({ target, deleteSession, onClose, t }: {
  target: { id: SessionId; title: string }
  deleteSession: (id: SessionId) => Promise<void>
  onClose: () => void
  t: WorkspaceBrowserProps['t']
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const close = () => { if (!busy) onClose() }
  const confirm = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await deleteSession(target.id)
      onClose()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={close} closeLabel={t('close')} title={t('delete.session')}
      description={t('delete.session.desc', { name: target.title })}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
        <Button variant="outline" className={css.deleteAction} disabled={busy} onClick={() => { void confirm() }}>
          {busy ? t('delete.session.pending') : t('delete.session')}
        </Button>
      </>}
    >
      {error === undefined ? null : <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
