/** Conversation history picker shared by the header and edited prompt actions. */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionId, ConversationVersion } from '@hydraharness/harness-client-runtime/client'
import type { SessionVersionId } from '@hydraharness/harness-session/types'
import { Menu } from '@hydraharness/harness-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './MessageItem.module.css'

/**
 * Pick a stored transcript without submitting a prompt or changing files.
 * @param props - Ordered versions, current identity, trigger contents, availability, and navigation callback.
 * @returns A version menu with current/latest markers and source-prompt labels.
 */
export function PromptVersionMenu({ versions, sessionId, openVersion, referenceVersion, children, className, disabled = false, t }: {
  versions: readonly ConversationVersion[]
  sessionId: SessionId
  openVersion: (id: SessionId | SessionVersionId) => void | Promise<void>
  referenceVersion?: ((id: SessionId | SessionVersionId) => void | Promise<void>) | undefined
  children: ReactNode
  className: string | undefined
  disabled?: boolean
  t: ChatViewSlotProps['t']
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const labels = useRef(new Map<string, HTMLSpanElement>())
  const selectedId = versions.find(version => version.selected === true)?.id ?? sessionId
  useLayoutEffect(() => {
    if (!open) return
    // The portaled Menu is hidden until its layout effect places it.
    const frame = requestAnimationFrame(() => { labels.current.get(selectedId)?.closest('button')?.focus() })
    return () => { cancelAnimationFrame(frame) }
  }, [open, selectedId])
  return (
    <span onKeyDown={(event) => {
      if (!open || event.target === trigger.current) return
      const menu = event.currentTarget.querySelector('[role="menu"]') ?? labels.current.get(selectedId)?.closest('[role="menu"]')
      const items = menu === null || menu === undefined ? [] : [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      if (items.length === 0) return
      const index = items.findIndex(item => item === event.target)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length
          : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : undefined
      if (next === undefined) return
      event.preventDefault()
      items[next]?.focus()
    }}>
      <Menu open={open} portal align="end" selectedId={selectedId}
        onClose={() => { setOpen(false); trigger.current?.focus() }}
        onSelect={(id) => {
          setOpen(false)
          trigger.current?.focus()
          const selected = versions.find(version => version.id === id || `reference:${version.id}` === id)
          if (selected === undefined || busy) return
          setBusy(true); setError(null); setStatus(null)
          void Promise.resolve().then(() => id.startsWith('reference:')
            ? referenceVersion?.(selected.id) : selected.id !== selectedId ? openVersion(selected.id) : undefined)
            .then(() => {
              if (id.startsWith('reference:')) setStatus(t('message.referenceAdded', { version: String(versions.indexOf(selected) + 1) }))
            })
            .catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) })
            .finally(() => { setBusy(false) })
        }}
        items={[{ type: 'label', id: 'version-history', text: t('message.versions') }, ...versions.map((version, index) => {
          const parentIndex = versions.findIndex(parent => parent.id === version.revision?.previousVersionId
            || parent.id === version.revision?.previousSessionId
            || (parent.revision?.revisionId !== undefined && parent.revision.revisionId === version.revision?.previousSessionId))
          return {
            id: version.id,
            label: <span className={css.versionOption} ref={(element) => {
              if (element === null) labels.current.delete(version.id)
              else labels.current.set(version.id, element)
            }}>
              <span className={css.versionTitle}>
                <span>{t('message.version', { version: String(index + 1) })}</span>
                {index === versions.length - 1 && <>{' '}<span className={css.versionBadge}>{t('message.latestVersion')}</span></>}
                {version.id === selectedId && <>{' '}<span className={css.versionBadge} data-viewing>{t('message.viewingVersion')}</span></>}
              </span>
              {' '}
              <span className={css.versionDetail}>{version.revision === undefined
                ? t('message.originalVersion')
                : t('message.revisedTurn', { turn: String(version.revision.turn) })}
              {parentIndex >= 0 ? ` · ${t('message.fromVersion', { version: String(parentIndex + 1) })}` : ''}</span>
            </span>,
          }
        }), ...referenceVersion === undefined ? [] : [
          { type: 'label' as const, id: 'version-references', text: t('message.referenceVersions') },
          ...versions.map((version, index) => ({ id: `reference:${version.id}`, label: t('message.referenceVersion', { version: String(index + 1) }) })),
        ]]}
        anchor={<button data-hydra-control="action" ref={trigger} type="button" className={className} aria-label={t('message.seeVersions')}
          title={t('message.seeVersions')} aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy} onClick={() => { setOpen(!open) }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M3 2h11M10 6h4M11 10h3M11 14h3" />
            <circle cx="4.5" cy="10" r="3.5" />
            <path d="M4.5 8v2l1.5 1" />
          </svg>
          {children}
        </button>}
      />
      {error !== null && <span role="alert" className={css.editError}>{error}</span>}
      {status !== null && <span role="status" className={css.versionDetail}>{status}</span>}
    </span>
  )
}
