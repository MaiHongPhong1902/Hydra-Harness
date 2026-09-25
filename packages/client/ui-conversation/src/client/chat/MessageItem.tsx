// MessageItem: simple chat nodes — user and consumed-steering bubbles
// (right-aligned, with clock, copy and user edit actions; branch lives only under
// assistant answers), pending steering (copy only), context injection,
// compaction marker, retry disclosure, and unknown-surface JSON rows.

import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ModelRetryNode, SessionId, TurnErrorNode, UserMessageNode,
} from '@hydra/harness-client-runtime/client'
import { conversationVersions } from '@hydra/harness-client-runtime/client'
import { Button, IconChevronDownOutline14, JsonBlock, MessageText, StateDot } from '@hydra/harness-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import { ReferenceIcon } from '../reference/ReferenceIcon.tsx'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import { PromptVersionMenu } from './PromptVersionMenu.tsx'
import css from './MessageItem.module.css'
import actionCss from './MessageIconActions.module.css'
import type { PromptEditOptions } from '../contract/prompt-edit.ts'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>

function contentParts(content: readonly unknown[]): {
  text: string
  images: { attachment: UserImage['attachment'] }[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: { attachment: UserImage['attachment'] }[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      images.push({ attachment: (b as UserImage).attachment })
    }
    else rest.push(block)
  }
  return { text: texts.join(''), images, rest }
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function ModelRetryItem({ node, active, t }: {
  node: ModelRetryNode
  active: boolean
  t: ChatViewSlotProps['t']
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])
  const scheduledSeconds = retrySeconds(node.delayMs)
  const maximum = node.mode === 'normal' ? node.maxRetries : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : node.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : node.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {Math.round(node.delayMs)}ms
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {node.failure.message}
        </div>
      </div>
    </details>
  )
}

/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }: {
  node: TurnErrorNode
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{node.message}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: {
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/**
 * Display projection of reference forms in a user bubble (free geometry — no
 * textarea alignment constraint here); everything else stays plain text. The
 * logged model text remains the single truth; this is presentation only.
 * Plain-text `/name` / `@name` word-boundary tokens decorate (the sent text
 * IS the reference — the bubble uses the same plainest token
 * scan as the composer, minus the lexicon: sent tokens were validated at
 * compose time, so shape alone decorates).
 */
function projectUserText(text: string, sessionLabels: readonly string[]): ReactNode {
  const ranges: { start: number; end: number; label: string; kind: 'session' | 'plain' }[] = []
  for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      ranges.push({ start, end: start + label.length, label, kind: 'session' })
      start = text.indexOf(label, start + label.length)
    }
  }
  const re = /(^|\s)(\/[\w-]+|@"[^"\n]+"|@[^\s]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1]?.length ?? 0)
    const rawLabel = m[2] ?? ''
    const label = rawLabel.startsWith('@"')
      ? rawLabel
      : rawLabel.replace(/[.,;:!?，。；：！？]+$/gu, '')
    if (label.length <= 1) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' })
  }
  ranges.sort((a, b) => a.start - b.start
    || (a.kind === b.kind ? b.end - a.end : a.kind === 'session' ? -1 : 1))
  const parts: ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    const { start: tokenStart, end, label, kind } = range
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    const referenceKind = kind === 'session'
      ? 'session'
      : label.startsWith('@')
        ? label.endsWith('/') ? 'folder' : 'file'
        : undefined
    const displayLabel = referenceKind === undefined
      ? label
      : referenceKind === 'session'
        ? label.slice(1)
        : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1)
    parts.push(
      <span
        key={tokenStart}
        className={css.refChip}
        data-ref-chip={referenceKind ?? 'skill'}
        title={label}
      >
        {referenceKind !== undefined && (
          <ReferenceIcon kind={referenceKind} size={16} className={css.refIcon} />
        )}
        {displayLabel}
      </span>,
    )
    cursor = end
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({
  content, renderMessageImages, actions, editor, pending = false, referenceLabels = [], t,
}: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: ((text: string) => ReactNode) | undefined
  /** Local inline editor replacing the displayed text while keeping images visible. */
  editor?: ReactNode
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  /** Exact session mention labels associated by the adjacent recall node. */
  referenceLabels?: readonly string[]
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { text, images, rest } = contentParts(content)
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  return (
    <div className={css.userRow} data-pending-steering={pending || undefined}>
      <div className={css.userStack} data-editing={editor !== undefined || undefined}>
        {renderMessageImages({ images, align: 'end' })}
        {(showBubble || editor !== undefined) && <div className={css.bubble}>
          {editor ?? projectUserText(text, referenceLabels)}
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
        </div>}
        {editor === undefined && referenceLabels.length > 0 && (
          <div className={css.referenceSummary}>
            {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
          </div>
        )}
      </div>
      {actions?.(text)}
    </div>
  )
}

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({ content, renderMessageImages, t }: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  return (
    <UserStyleBubble
      content={content}
      renderMessageImages={renderMessageImages}
      pending
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

function PromptVersionsAction({ sessionId, useSessions, turn, open, t }: {
  sessionId: SessionId
  useSessions: ChatNodeViewProps['useSessions']
  turn: number
  open: (id: SessionId) => void
  t: ChatNodeViewProps['t']
}) {
  const versions = useSessions(list => conversationVersions(list, sessionId), (a, b) =>
    a.length === b.length && a.every((version, index) => version.id === b[index]?.id && version.revision === b[index].revision))
  if (versions.length < 2 || !versions.some(version => version.revision?.turn === turn)) return null
  const versionIndex = versions.findIndex(version => version.id === sessionId)
  return (
    <PromptVersionMenu versions={versions} sessionId={sessionId} openVersion={open} t={t}
      className={`${actionCss.action} ${css.versionTrigger}`}>
      {versionIndex + 1}/{versions.length}<IconChevronDownOutline14 />
    </PromptVersionMenu>
  )
}

/** User and admitted-steering keyed Chat renderer. */
export const UserMessageNodeView = memo(function UserMessageNodeView({
  node, renderMessageImages, editMessage, openVersion, sessionId, useSessions, t,
}: ChatNodeViewProps<'user' | 'steering'> & {
  /** Submit a prompt revision in this conversation; rejection keeps this editor open. */
  editMessage?: (node: UserMessageNode, text: string, options: PromptEditOptions) => Promise<void>
  /** Open another stored version without creating a conversation. */
  openVersion?: (id: SessionId) => void
}) {
  const data = node.data
  const [draft, setDraft] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const descriptionId = useId()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const editTrigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const pending = useRef(false)
  const admissionKey = useRef<string | null>(null)
  const parts = contentParts(data.content)
  const canSend = draft !== null && (draft.trim() !== '' || parts.images.length > 0)
  const editing = draft !== null
  useLayoutEffect(() => {
    const input = textarea.current
    if (editing && input !== null) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    } else if (!editing && restoreFocus.current) {
      restoreFocus.current = false
      editTrigger.current?.focus()
    }
  }, [editing])
  useLayoutEffect(() => {
    const input = textarea.current
    if (input === null) return
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }, [draft])
  const cancel = (): void => {
    restoreFocus.current = true
    setDraft(null); setError(null)
    admissionKey.current = null
  }
  const send = async (): Promise<void> => {
    if (pending.current || draft === null || !canSend
      || editMessage === undefined) return
    pending.current = true
    setSending(true)
    setError(null)
    try {
      admissionKey.current ??= crypto.randomUUID()
      await editMessage({ ...node.data, kind: 'user' }, draft, {
        idempotencyKey: admissionKey.current,
      })
      setDraft(null)
    } catch (failure) {
      setError(t('message.editFailed', { message: failure instanceof Error ? failure.message : String(failure) }))
    } finally {
      pending.current = false
      setSending(false)
    }
  }
  const editable = editMessage !== undefined
    && data.content.every(block => block.type === 'text' || block.type === 'image')
  return (
    <UserStyleBubble
      content={data.content}
      renderMessageImages={renderMessageImages}
      {...data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }}
      t={t}
      editor={draft === null ? undefined : (
        <form aria-label={t('message.editPrompt')} aria-busy={sending}
          onSubmit={(event) => { event.preventDefault(); void send() }}>
          <div className={css.editHeading}>{t('message.editPrompt')}</div>
          <textarea data-hydra-control="editor"
            ref={textarea}
            className={css.editText}
            aria-label={t('message.editPrompt')}
            aria-describedby={descriptionId}
            value={draft}
            disabled={sending}
            rows={1}
            onChange={(event) => { setDraft(event.currentTarget.value); admissionKey.current = null }}
            onKeyDown={(event) => {
              // oxlint-disable-next-line typescript/no-deprecated
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
              if (event.key === 'Escape' && !sending) { event.preventDefault(); cancel() }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                if (!event.repeat) void send()
              }
            }}
          />
          <p id={descriptionId} className={css.editHint}>{t('message.editEffect')}</p>
          {error !== null && <p className={css.editError} role="alert">{error}</p>}
          <div className={css.editActions}>
            <span className={css.editKeys}>{t('message.editKeys')}</span>
            <Button type="button" variant="outline" size="sm" disabled={sending} onClick={cancel}>{t('cancel')}</Button>
            <Button type="submit" variant="primary" size="sm" disabled={sending || !canSend}>
              {t(sending ? 'message.editSending' : 'message.editSend')}
            </Button>
          </div>
        </form>
      )}
      actions={draft !== null ? undefined : text => (
        <MessageIconActions
          text={text}
          time={data.time}
          clock="start"
          className={css.actions}
          editButtonRef={editTrigger}
          onEdit={editable ? () => { setDraft(text); setError(null) } : undefined}
          extraActions={openVersion !== undefined && (node.location.kind === 'turn' || node.location.kind === 'step')
            ? <PromptVersionsAction sessionId={sessionId} useSessions={useSessions} turn={node.location.turn.turn}
              open={openVersion} t={t} />
            : undefined}
          t={t}
        />
      )}
    />
  )
})

/** Injected-context keyed Chat renderer. */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({ node, t }: ChatNodeViewProps<'context'>) {
  const data = node.data
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      provenance={data.provenance}
      form={data.form}
      t={t}
    />
  )
})

/** Automatic compaction keyed Chat renderer. */
export const CompactionNodeView = memo(function CompactionNodeView({ node, t }: ChatNodeViewProps<'compaction'>) {
  return <CompactionItem node={node.data} t={t} />
})

/** Correlated retry-chain keyed Chat renderer. */
export const RetryNodeView = memo(function RetryNodeView({ node, t }: ChatNodeViewProps<'model-retry'>) {
  const data = node.data
  return <ModelRetryItem node={data.current} active={data.current.retryState === 'scheduled'} t={t} />
})

/** Terminal turn-error keyed Chat renderer. */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, t }: ChatNodeViewProps<'turn-error'>) {
  return <TurnErrorItem node={node.data} t={t} />
})

/**
 * Retry a terminal revision attempt without creating another user revision.
 * @param props - Turn identity, framework state hooks, and Host retry callback.
 * @returns A retry control for the latest admitted prompt, with retained request errors.
 */
export function RevisionRetryAction({ turn, t, sessionId, useSessions, useSession, retryRevision }:
  Pick<ChatNodeViewProps, 't' | 'sessionId' | 'useSessions' | 'useSession'> & {
    turn: number
    retryRevision?: (key: string) => Promise<void>
  }) {
  const revision = useSessions(list => list.byId[sessionId]?.revision)
  const running = useSession(snapshot => snapshot.running)
  const latest = useSession(snapshot => snapshot.chat.timeline.turnOrder.at(-1) === turn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const pending = useRef(false)
  if (revision?.revisionId === undefined || revision.turn !== turn || !latest || retryRevision === undefined) return null
  return <>
    <Button disabled={busy || running}
      onClick={() => {
        if (pending.current || running) return
        pending.current = true; setBusy(true); setError(null)
        key.current ??= crypto.randomUUID()
        void retryRevision(key.current).catch((failure: unknown) => {
          setError(failure instanceof Error ? failure.message : String(failure))
        }).finally(() => { pending.current = false; setBusy(false) })
      }}>{t('message.retryGeneration')}</Button>
    {error !== null && <p role="alert">{error}</p>}
  </>
}

/** Max-tokens turn-end notice keyed Chat renderer. */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({ t }: ChatNodeViewProps<'turn-max-tokens'>) {
  return <TurnMaxTokensItem t={t} />
})

/** Explicit unknown-surface keyed Chat renderer. */
export const UnknownNodeView = memo(function UnknownNodeView({ node, t }: ChatNodeViewProps<'unknown'>) {
  const data = node.data
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: data.type })}
        payload={data.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
