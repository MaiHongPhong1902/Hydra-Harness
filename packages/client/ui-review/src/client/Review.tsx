/** Persisted agent edit history and inline review actions. @module */
import { useMemo, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@hydra/harness-client-ui-slots'
import type { ReviewChange, ReviewHunk } from '@hydra/harness-fs-review/client'
import type { ReviewHistory, ReviewSnapshot } from './history.ts'
import css from './Review.module.css'

const cx = (...args: (string | boolean | undefined | null)[]): string => args.filter(Boolean).join(' ')

/** Business actions and observable supplied by the slot registration. */
export interface ReviewInjected {
  ownerSessionId: ReviewChange['sessionId']
  hooks: { review: ReviewHistory }
  act: ReviewHistory['act']
  refresh: ReviewHistory['refresh']
}

interface HunkLineItem {
  oldNo: string
  newNo: string
  type: 'add' | 'del' | 'context'
  line: string
}

function parseHunkNumbers(header: string): { oldStart: number; newStart: number } {
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(header)
  const oldVal = match?.[1]
  const newVal = match?.[3]
  return {
    oldStart: oldVal ? parseInt(oldVal, 10) : 1,
    newStart: newVal ? parseInt(newVal, 10) : 1,
  }
}

function processHunk(hunk: ReviewHunk): { items: HunkLineItem[] } {
  const { oldStart, newStart } = parseHunkNumbers(hunk.header)
  let currentOld = oldStart
  let currentNew = newStart
  const items: HunkLineItem[] = []
  for (const line of hunk.lines) {
    if (line.startsWith('+')) {
      items.push({ oldNo: '', newNo: String(currentNew++), type: 'add', line })
    } else if (line.startsWith('-')) {
      items.push({ oldNo: String(currentOld++), newNo: '', type: 'del', line })
    } else {
      items.push({ oldNo: String(currentOld++), newNo: String(currentNew++), type: 'context', line })
    }
  }
  return { items }
}

function getDiffText(hunks: readonly ReviewHunk[]): string {
  return hunks.map(h => `${h.header}\n${h.lines.join('\n')}`).join('\n')
}

/** One historical mutation with recorded hunks and safe host-side actions. */
export function ChangeRow({ change, pending, act }: {
  change: ReviewChange
  pending: boolean
  act: ReviewHistory['act']
}) {
  const [copied, setCopied] = useState(false)
  const completed = change.state === 'rolledBack'
  const uncertain = change.state === 'pending' || change.state === 'undoing'
  const statusLetter = ({ added: 'A', modified: 'M', deleted: 'D' })[change.status]
  const statusClass = change.status === 'added' ? css.statusAdded : change.status === 'deleted' ? css.statusDeleted : css.statusModified

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    const text = getDiffText(change.hunks)
    if (!text) return
    void (navigator.clipboard?.writeText(text) ?? Promise.resolve()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <section className={css.change} aria-label={`${change.path} ${change.state}`}>
      <details>
        <summary>
          <span className={cx(css.statusBadge, statusClass)} aria-label={change.status}>{statusLetter}</span>
          <span className={completed ? css.undone : css.filePath}>{change.path}</span>
          <span className={css.additions}>+{change.additions}</span>
          <span className={css.deletions}>−{change.deletions}</span>
          <span className={cx(css.state, change.state === 'kept' && css.stateKept, completed && css.stateUndone)}>
            {completed ? 'Undone' : change.state === 'kept' ? 'Kept' : uncertain ? 'Incomplete' : 'View diff'}
          </span>
        </summary>
        <p className={css.attribution}>
          {change.parentSessionId ? 'Subagent' : 'Hydra'}{change.agentPreset ? ` · ${change.agentPreset}` : ''}
          {' · '}{change.toolName}{' · '}<time dateTime={new Date(change.createdAt).toISOString()}>{new Date(change.createdAt).toLocaleString()}</time>
          <br />Session {change.sessionId} · Tool call {change.callId}
          {change.parentSessionId ? <><br />Parent session {change.parentSessionId}</> : null}
        </p>
        <div className={css.diffContainer}>
          {change.binary ? <p style={{ padding: '12px' }}>Binary file — text diff unavailable.</p>
            : change.truncated ? <p style={{ padding: '12px' }}>Diff exceeds the preview limit.</p>
              : change.hunks.length === 0 ? <p style={{ padding: '12px' }}>No line changes.</p> : (
                <pre className={css.diff} aria-label={`Recorded diff for ${change.path}`}>
                  {change.hunks.map((hunk, i) => {
                    const { items } = processHunk(hunk)
                    return (
                      <span key={i}>
                        <span className={css.hunk}>{hunk.header}{'\n'}</span>
                        {items.map((item, j) => (
                          <span key={j} className={cx(css.diffLine, item.type === 'add' && css.lineAdd, item.type === 'del' && css.lineDel)}>
                            <span className={css.lineGutter} aria-hidden="true" data-old={item.oldNo} data-new={item.newNo} />
                            <span className={css.lineText}>{item.line}{'\n'}</span>
                          </span>
                        ))}
                      </span>
                    )
                  })}
                </pre>
              )}
        </div>
      </details>
      <div className={css.actions}>
        <button
          type="button"
          className={css.btnKeep}
          onClick={() => { void act(change, 'keep') }}
          disabled={pending || completed || uncertain || change.state === 'kept'}
          title="Keep this file change"
        >
          Keep
        </button>
        <button
          type="button"
          className={css.btnUndo}
          onClick={() => { void act(change, 'undo') }}
          disabled={pending || completed || uncertain || !change.reversible}
          title="Undo this file change"
        >
          Undo
        </button>
        <button
          type="button"
          className={css.copyBtn}
          onClick={handleCopy}
          disabled={pending || completed || uncertain || change.binary || change.hunks.length === 0}
          title="Copy diff to clipboard"
        >
          {copied ? 'Copied!' : 'Copy diff'}
        </button>
        {!change.reversible || uncertain ? <span>Undo unavailable</span> : null}
        {pending ? <span role="status">Saving…</span> : null}
      </div>
    </section>
  )
}

function HistoryRows({
  snapshot,
  act,
  callId,
  ownerSessionId,
  filterChanges,
}: {
  snapshot: ReviewSnapshot
  act: ReviewHistory['act']
  callId?: string
  ownerSessionId?: ReviewChange['sessionId']
  filterChanges?: readonly ReviewChange[]
}) {
  const changes = filterChanges ?? (callId === undefined ? snapshot.changes
    : snapshot.changes.filter(change => change.callId === callId && change.sessionId === ownerSessionId))
  if (callId !== undefined && changes.length === 0 && !snapshot.error) return null
  return (
    <div className={css.rows}>
      {snapshot.error ? <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', padding: '8px 0' }}>{snapshot.error}</p> : null}
      {changes.map(change => <ChangeRow key={change.id} change={change} pending={snapshot.pending.has(change.id)} act={act} />)}
    </div>
  )
}

/** Review panel occupying the desktop right panel's Review seat. */
export function ReviewPanel({ useReview, act, refresh }: PropsRuntime<'review'> & InjectFace<ReviewInjected>) {
  const snapshot = useReview(value => value)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'pending' | 'kept' | 'undone'>('all')

  const files = new Set(snapshot.changes.map(change => `${change.workspace}/${change.path}`)).size

  const { totalAdditions, totalDeletions, pendingCount, keptCount, undoneCount } = useMemo(() => {
    let additions = 0
    let deletions = 0
    let pending = 0
    let kept = 0
    let undone = 0
    for (const c of snapshot.changes) {
      additions += c.additions
      deletions += c.deletions
      if (c.state === 'kept') kept++
      else if (c.state === 'rolledBack') undone++
      else pending++
    }
    return { totalAdditions: additions, totalDeletions: deletions, pendingCount: pending, keptCount: kept, undoneCount: undone }
  }, [snapshot.changes])

  const filteredChanges = useMemo(() => {
    let result = snapshot.changes
    if (search.trim()) {
      const q = search.toLowerCase().trim()
      result = result.filter(c => c.path.toLowerCase().includes(q))
    }
    if (filter === 'pending') {
      result = result.filter(c => c.state !== 'kept' && c.state !== 'rolledBack')
    } else if (filter === 'kept') {
      result = result.filter(c => c.state === 'kept')
    } else if (filter === 'undone') {
      result = result.filter(c => c.state === 'rolledBack')
    }
    return result
  }, [snapshot.changes, search, filter])

  const handleKeepAll = async () => {
    const targets = snapshot.changes.filter(c => c.state !== 'kept' && c.state !== 'rolledBack' && c.state !== 'pending' && c.state !== 'undoing')
    for (const c of targets) {
      await act(c, 'keep')
    }
  }

  const handleUndoAll = async () => {
    const targets = snapshot.changes.filter(c => c.reversible && c.state !== 'rolledBack' && c.state !== 'pending' && c.state !== 'undoing')
    for (const c of targets) {
      await act(c, 'undo')
    }
  }

  return (
    <section className={css.panel} aria-label="Review">
      <header>
        <strong className={css.panelTitle}>Review</strong>
        <span className={css.panelSubtitle}>{snapshot.changes.length} changes · {files} {files === 1 ? 'file' : 'files'}</span>
        {totalAdditions > 0 && <span className={cx(css.statPill, css.statAdd)}>+{totalAdditions}</span>}
        {totalDeletions > 0 && <span className={cx(css.statPill, css.statDel)}>−{totalDeletions}</span>}
        <button type="button" onClick={() => { void refresh() }}>Refresh</button>
      </header>

      {snapshot.changes.length > 0 && (
        <div className={css.toolbar}>
          <input
            type="search"
            className={css.searchBox}
            placeholder="Filter changes by file..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Filter changes by file"
          />
          <div className={css.filterTabs} role="tablist" aria-label="Filter status">
            <button
              type="button"
              className={css.filterTab}
              role="tab"
              aria-selected={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              All ({snapshot.changes.length})
            </button>
            <button
              type="button"
              className={css.filterTab}
              role="tab"
              aria-selected={filter === 'pending'}
              onClick={() => setFilter('pending')}
            >
              Pending ({pendingCount})
            </button>
            <button
              type="button"
              className={css.filterTab}
              role="tab"
              aria-selected={filter === 'kept'}
              onClick={() => setFilter('kept')}
            >
              Kept ({keptCount})
            </button>
            <button
              type="button"
              className={css.filterTab}
              role="tab"
              aria-selected={filter === 'undone'}
              onClick={() => setFilter('undone')}
            >
              Undone ({undoneCount})
            </button>
          </div>
          <div className={css.batchActions}>
            <button
              type="button"
              className={css.btnKeep}
              onClick={() => { void handleKeepAll() }}
              disabled={pendingCount === 0 || snapshot.pending.size > 0}
              title="Keep all pending changes"
            >
              Keep All
            </button>
            <button
              type="button"
              className={css.btnUndo}
              onClick={() => { void handleUndoAll() }}
              disabled={snapshot.changes.every(c => !c.reversible || c.state === 'rolledBack') || snapshot.pending.size > 0}
              title="Undo all reversible changes"
            >
              Undo All
            </button>
          </div>
        </div>
      )}

      {snapshot.loading ? <p role="status">Loading changes…</p> : snapshot.changes.length === 0 ? <p>No agent file changes in this session.</p> : null}
      {snapshot.changes.length > 0 && filteredChanges.length === 0 && (
        <p className={css.emptyState}>No changes match &ldquo;{search}&rdquo;</p>
      )}
      <HistoryRows snapshot={snapshot} act={act} filterChanges={filteredChanges} />
    </section>
  )
}

/** The same evidence and actions next to the owning Write/Edit tool result. */
export function InlineReview({ callId, useReview, act, ownerSessionId }: PropsRuntime<'tool.call.review'> & InjectFace<ReviewInjected>) {
  return <HistoryRows snapshot={useReview(value => value)} act={act} callId={callId} ownerSessionId={ownerSessionId} />
}
