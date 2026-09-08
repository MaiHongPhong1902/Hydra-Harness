/** Persisted agent edit history and inline review actions. @module */
import type { InjectFace, PropsRuntime } from '@hydra/harness-client-ui-slots'
import type { ReviewChange } from '@hydra/harness-fs-review/client'
import type { ReviewHistory, ReviewSnapshot } from './history.ts'
import css from './Review.module.css'

/** Business actions and observable supplied by the slot registration. */
export interface ReviewInjected {
  ownerSessionId: ReviewChange['sessionId']
  hooks: { review: ReviewHistory }
  act: ReviewHistory['act']
  refresh: ReviewHistory['refresh']
}

/** One historical mutation with recorded hunks and safe host-side actions. */
export function ChangeRow({ change, pending, act }: {
  change: ReviewChange
  pending: boolean
  act: ReviewHistory['act']
}) {
  const completed = change.state === 'rolledBack'
  const uncertain = change.state === 'pending' || change.state === 'undoing'
  return <section className={css.change} aria-label={`${change.path} ${change.state}`}>
    <details>
      <summary>
        <span aria-label={change.status}>{({ added: 'A', modified: 'M', deleted: 'D' })[change.status]}</span>
        <span className={completed ? css.undone : undefined}>{change.path}</span>
        <span className={css.additions}>+{change.additions}</span>
        <span className={css.deletions}>−{change.deletions}</span>
        <span className={css.state}>{completed ? 'Undone' : change.state === 'kept' ? 'Kept' : uncertain ? 'Incomplete' : 'View diff'}</span>
      </summary>
      <p className={css.attribution}>
        {change.parentSessionId ? 'Subagent' : 'Hydra'}{change.agentPreset ? ` · ${change.agentPreset}` : ''}
        {' · '}{change.toolName}{' · '}<time dateTime={new Date(change.createdAt).toISOString()}>{new Date(change.createdAt).toLocaleString()}</time>
        <br />Session {change.sessionId} · Tool call {change.callId}
        {change.parentSessionId ? <><br />Parent session {change.parentSessionId}</> : null}
      </p>
      {change.binary ? <p>Binary file — text diff unavailable.</p>
        : change.truncated ? <p>Diff exceeds the preview limit.</p> : change.hunks.length === 0 ? <p>No line changes.</p> :
          <pre className={css.diff} aria-label={`Recorded diff for ${change.path}`}>{change.hunks.map((hunk, i) => <span key={i}>
            <span className={css.hunk}>{hunk.header}{'\n'}</span>
            {hunk.lines.map((line, j) => <span key={j} className={line.startsWith('+') ? css.additions : line.startsWith('-') ? css.deletions : undefined}>{line}{'\n'}</span>)}
          </span>)}</pre>}
    </details>
    <div className={css.actions}>
      <button type="button" onClick={() => { void act(change, 'keep') }} disabled={pending || completed || uncertain || change.state === 'kept'}>Keep</button>
      <button type="button" onClick={() => { void act(change, 'undo') }} disabled={pending || completed || uncertain || !change.reversible}>Undo</button>
      {!change.reversible || uncertain ? <span>Undo unavailable</span> : null}
      {pending ? <span role="status">Saving…</span> : null}
    </div>
  </section>
}

function HistoryRows({ snapshot, act, callId, ownerSessionId }: { snapshot: ReviewSnapshot; act: ReviewHistory['act']; callId?: string; ownerSessionId?: ReviewChange['sessionId'] }) {
  const changes = callId === undefined ? snapshot.changes
    : snapshot.changes.filter(change => change.callId === callId && change.sessionId === ownerSessionId)
  if (callId !== undefined && changes.length === 0 && !snapshot.error) return null
  return <div className={css.rows}>
    {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
    {changes.map(change => <ChangeRow key={change.id} change={change} pending={snapshot.pending.has(change.id)} act={act} />)}
  </div>
}

/** Review panel occupying the desktop right panel's Review seat. */
export function ReviewPanel({ useReview, act, refresh }: PropsRuntime<'review'> & InjectFace<ReviewInjected>) {
  const snapshot = useReview(value => value)
  const files = new Set(snapshot.changes.map(change => `${change.workspace}/${change.path}`)).size
  return <section className={css.panel} aria-label="Review">
    <header><strong>Review</strong><span>{snapshot.changes.length} changes · {files} {files === 1 ? 'file' : 'files'}</span><button type="button" onClick={() => { void refresh() }}>Refresh</button></header>
    {snapshot.loading ? <p role="status">Loading changes…</p> : snapshot.changes.length === 0 ? <p>No agent file changes in this session.</p> : null}
    <HistoryRows snapshot={snapshot} act={act} />
  </section>
}

/** The same evidence and actions next to the owning Write/Edit tool result. */
export function InlineReview({ callId, useReview, act, ownerSessionId }: PropsRuntime<'tool.call.review'> & InjectFace<ReviewInjected>) {
  return <HistoryRows snapshot={useReview(value => value)} act={act} callId={callId} ownerSessionId={ownerSessionId} />
}
