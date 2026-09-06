/** Conversation history picker shared by the header and edited prompt actions. */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionId, SessionSummary } from '@hydra/harness-client-runtime/client'
import { Menu } from '@hydra/harness-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './MessageItem.module.css'

/**
 * Pick a stored transcript without submitting a prompt or changing files.
 * @param props - Ordered versions, current identity, trigger contents and navigation callback.
 * @returns A version menu with a selected marker and edited-prompt labels.
 */
export function PromptVersionMenu({ versions, sessionId, openVersion, children, className, t }: {
  versions: readonly SessionSummary[]
  sessionId: SessionId
  openVersion: (id: SessionId) => void
  children: ReactNode
  className: string | undefined
  t: ChatViewSlotProps['t']
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const labels = useRef(new Map<string, HTMLSpanElement>())
  useLayoutEffect(() => {
    if (!open) return
    // The portaled Menu is hidden until its layout effect places it.
    const frame = requestAnimationFrame(() => { labels.current.get(sessionId)?.closest('button')?.focus() })
    return () => { cancelAnimationFrame(frame) }
  }, [open, sessionId])
  return (
    <span onKeyDown={(event) => {
      if (!open || event.target === trigger.current) return
      const items = [...labels.current.values()].map(label => label.closest('button'))
      const index = items.findIndex(item => item === event.target)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length
          : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : undefined
      if (next === undefined) return
      event.preventDefault()
      items[next]?.focus()
    }}>
      <Menu open={open} portal align="end" selectedId={sessionId}
        onClose={() => { setOpen(false); trigger.current?.focus() }}
        onSelect={(id) => {
          setOpen(false)
          trigger.current?.focus()
          const selected = versions.find(version => version.id === id)
          if (selected !== undefined && selected.id !== sessionId) openVersion(selected.id)
        }}
        items={versions.map((version, index) => ({
          id: version.id,
          label: <span className={css.versionOption} ref={(element) => {
            if (element === null) labels.current.delete(version.id)
            else labels.current.set(version.id, element)
          }}>
            <span>{t('message.version', { version: String(index + 1) })}
              {index === versions.length - 1 ? ` · ${t('message.currentVersion')}` : ''}</span>
            <span className={css.versionDetail}>{version.revision === undefined
              ? t('message.originalVersion')
              : t('message.editedTurn', { turn: String(version.revision.turn) })}</span>
          </span>,
        }))}
        anchor={<button ref={trigger} type="button" className={className} aria-label={t('message.seeVersions')}
          aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}>{children}</button>}
      />
    </span>
  )
}
