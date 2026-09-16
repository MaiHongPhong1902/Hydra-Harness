/** Compact session overview anchored to its header utility. @module */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HostDescriptionSource } from '@hydra/harness-client-connection/client'
import {
  IconAgentPresetOutline16, IconBranchOutline16, IconBrowserOutline16,
  IconChevronDownOutline14, IconEditOutline16, IconLinkOutline16,
  IconPaperclipOutline16, IconRefreshOutline16, IconShareOutline16,
  useAnchoredPosition,
} from '@hydra/harness-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@hydra/harness-client-ui-slots'
import { sameWorkspace, type ReviewInjected } from './Review.tsx'
import css from './SessionSummary.module.css'

/** Review and host observables bound by the slot renderer. */
export interface SessionSummaryInjected extends ReviewInjected {
  hooks: ReviewInjected['hooks'] & { hostDescription: HostDescriptionSource }
}

type SessionSummaryProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<SessionSummaryInjected>

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className={css.detailRow}><dt>{label}</dt><dd>{value}</dd></div>
}

function SummaryContent({
  sessionId, useSession, useSessions, useWorkspaces, useReview, useHostDescription, refreshWorkspace, refresh,
}: SessionSummaryProps) {
  const host = useHostDescription(value => value)
  const sessions = useSessions(state => state.byId)
  const session = sessions[sessionId]
  const nodes = useSession(state => state.chat.legacy.nodes)
  const hasMore = useSession(state => state.hasMore)
  const workspace = useWorkspaces(state => state.items.find(item => item.sessionIds.includes(sessionId)
    || (session?.cwd !== undefined && sameWorkspace(item.path, session.cwd))))
  const review = useReview(state => state)
  const [expanded, setExpanded] = useState<'changes' | 'local' | 'git' | 'agents' | null>(null)
  const [allSources, setAllSources] = useState(false)
  const detailsId = useId()
  const sourcesId = useId()
  const toggle = (section: NonNullable<typeof expanded>) => { setExpanded(value => value === section ? null : section) }
  useEffect(() => { void refreshWorkspace?.() }, [refreshWorkspace])

  const sources = useMemo(() => {
    const attachments = new Map<string, { name: string; image: boolean }>()
    for (const node of nodes) {
      if (node.kind !== 'user' && node.kind !== 'steering' && node.kind !== 'context') continue
      for (const block of node.content) {
        if (block.type === 'file' || block.type === 'image') {
          attachments.set(block.attachment.attachmentId, { name: block.attachment.name ?? 'Image', image: block.type === 'image' })
        }
      }
    }
    return [...attachments].map(([id, value]) => ({ id, ...value }))
  }, [nodes])
  const children = Object.values(sessions).filter(item => item.parentId === sessionId)
  const git = review.workspace
  const loading = review.workspaceLoading
  const gitError = review.workspaceError
  const gitReady = !loading && gitError === null && git !== null
  const additions = git?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0
  const deletions = git?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0
  const comparison = git?.mode === 'unstaged' ? 'Unstaged' : git?.mode === 'staged' ? 'Staged'
    : git?.mode === 'committed' ? 'Commit' : git?.mode === 'branch' ? 'Branch' : 'Uncommitted'
  const branch = loading ? 'Loading branch…' : !gitReady ? 'Branch unavailable'
    : git.repository === null ? 'No Git repository' : git.branch ?? 'Detached HEAD'
  const status = session?.running === true ? 'Running' : session?.completed === true ? 'Completed' : 'Idle'

  return <>
    <section className={css.section} aria-label="Environment">
      <div className={css.heading}>
        <h3>Environment</h3>
        <button type="button" className={css.iconButton} aria-label="Refresh summary" title="Refresh summary"
          disabled={loading || review.loading} onClick={() => { void refresh() }}>
          <IconRefreshOutline16 size={14} />
        </button>
      </div>
      <button type="button" className={css.item} aria-label="Changes" aria-expanded={expanded === 'changes'}
        aria-controls={`${detailsId}-changes`} onClick={() => { toggle('changes') }}>
        <span className={css.icon} aria-hidden="true"><IconEditOutline16 /></span>
        <span className={css.label}>Changes</span>
        {gitReady && git.repository !== null
          ? <span className={css.stats}>
            <span className={css.additions}>+{additions.toLocaleString()}</span>
            <span className={css.deletions}>−{deletions.toLocaleString()}</span>
          </span>
          : <span className={css.meta}>{loading ? 'Loading…' : gitReady ? 'No Git' : 'Unavailable'}</span>}
      </button>
      {expanded === 'changes' && <div id={`${detailsId}-changes`} className={css.details}>
        {loading ? <p role="status">Loading changes…</p> : gitError ? <p role="alert">{gitError}</p>
          : gitReady && git.repository !== null ? <dl>
            <SummaryRow label="Comparison" value={comparison} />
            <SummaryRow label="Files" value={String(git.files.length)} />
            <SummaryRow label="Lines" value={`+${additions} / −${deletions}`} />
          </dl> : <p>{gitReady ? 'This workspace is not a Git repository.' : 'Workspace review is unavailable.'}</p>}
        {gitReady && (git.truncated || git.files.some(file => file.truncated)) && <p>Diff preview is limited; counts may be incomplete.</p>}
        {review.loading ? <p role="status">Loading session edits…</p> : review.error ? <p role="alert">{review.error}</p>
          : <dl><SummaryRow label="Session edits" value={String(review.changes.length)} /></dl>}
      </div>}
      <button type="button" className={css.item} aria-expanded={expanded === 'local'} aria-controls={`${detailsId}-local`}
        onClick={() => { toggle('local') }}>
        <span className={css.icon} aria-hidden="true"><IconBrowserOutline16 /></span>
        <span className={css.label}>Local</span><IconChevronDownOutline14 className={css.chevron} />
      </button>
      {expanded === 'local' && <dl id={`${detailsId}-local`} className={css.details}>
        <SummaryRow label="Workspace" value={workspace?.path ?? session?.cwd ?? 'Unavailable'} />
        <SummaryRow label="Session" value={String(sessionId)} />
        <SummaryRow label="Status" value={status} />
        <SummaryRow label="Agent preset" value={session?.agentPreset ?? 'Unavailable'} />
        <SummaryRow label="Host version" value={host?.version ?? 'Unavailable'} />
        <SummaryRow label="Default provider" value={host?.provider ?? 'Unavailable'} />
        <SummaryRow label="Default model" value={host?.model ?? 'Unavailable'} />
        <SummaryRow label="Home" value={host?.home ?? 'Unavailable'} />
        <SummaryRow label="Attached sessions" value={host === undefined ? 'Unavailable' : String(host.attachedSessions)} />
      </dl>}
      <button type="button" className={css.item} aria-label={branch} title={branch} aria-expanded={expanded === 'git'}
        aria-controls={`${detailsId}-git`} onClick={() => { toggle('git') }}>
        <span className={css.icon} aria-hidden="true"><IconBranchOutline16 /></span>
        <span className={css.label}>{branch}</span><IconChevronDownOutline14 className={css.chevron} />
      </button>
      {expanded === 'git' && <div id={`${detailsId}-git`} className={css.details}>
        {loading ? <p role="status">Loading repository…</p> : gitError ? <p role="alert">{gitError}</p>
          : gitReady && git.repository !== null ? <>
            <dl>
              <SummaryRow label="Repository" value={git.repository} />
              <SummaryRow label="Branch" value={git.branch ?? 'Detached HEAD'} />
            </dl>
            {git.commits.length > 0 && <><h4>Recent commits</h4><ul className={css.commits}>
              {git.commits.slice(0, 5).map(commit => <li key={commit.oid}><code>{commit.oid.slice(0, 7)}</code> {commit.subject}</li>)}
            </ul></>}
          </> : <p>{gitReady ? 'This workspace is not a Git repository.' : 'Repository information is unavailable.'}</p>}
      </div>}
      <button type="button" className={css.item} disabled title="Commit and push are not available in Hydra yet.">
        <span className={css.icon} aria-hidden="true"><IconShareOutline16 /></span><span className={css.label}>Commit or push</span>
      </button>
      <button type="button" className={css.item} disabled title="Pull requests are not available in Hydra yet.">
        <span className={css.icon} aria-hidden="true"><IconBranchOutline16 /></span><span className={css.label}>Create pull request</span>
      </button>
    </section>
    {children.length > 0 && <section className={css.section} aria-label="Subagents">
      <div className={css.heading}><h3>Subagents</h3></div>
      <button type="button" className={css.item} aria-expanded={expanded === 'agents'} aria-controls={`${detailsId}-agents`}
        onClick={() => { toggle('agents') }}>
        <span className={css.icon} aria-hidden="true"><IconAgentPresetOutline16 /></span>
        <span className={css.label}>{children.length} {children.length === 1 ? 'subagent' : 'subagents'}</span>
        <span className={css.meta}>{children.filter(child => child.running).length} running</span>
      </button>
      {expanded === 'agents' && <ul id={`${detailsId}-agents`} className={css.details}>
        {children.map(child => <li key={child.id}>
          {child.displayTitle} · {child.running ? 'Running' : child.completed ? 'Completed' : 'Idle'}
        </li>)}
      </ul>}
    </section>}
    <section className={css.section} aria-label="Sources">
      <div className={css.heading}><h3>Sources</h3>{sources.length > 0 && <span className={css.meta}>{sources.length}</span>}</div>
      {sources.length === 0 ? <p className={css.empty}>No attached sources</p> : <ul id={sourcesId} className={css.sources}>
        {(allSources ? sources : sources.slice(0, 3)).map(source => <li key={source.id} title={source.name}>
          <span className={css.icon} aria-hidden="true">{source.image ? <IconBrowserOutline16 /> : <IconPaperclipOutline16 />}</span>
          <span className={css.label}>{source.name}</span>
        </li>)}
      </ul>}
      {sources.length > 3 && <button type="button" className={css.item} aria-expanded={allSources} aria-controls={sourcesId}
        onClick={() => { setAllSources(value => !value) }}>
        <span className={css.icon} aria-hidden="true"><IconLinkOutline16 /></span>
        <span className={css.label}>{allSources ? 'Show less' : `View all (${sources.length})`}</span>
      </button>}
      {hasMore && <p className={css.empty}>Only loaded messages are included.</p>}
    </section>
  </>
}

/**
 * Render the header control and a nonmodal overview, dismissed by Escape or an outside press.
 * @param props - Framework-bound session, workspace, host, and review data.
 * @returns the utility and its anchored summary.
 */
export function SessionSummaryAction(props: SessionSummaryProps) {
  const [openSession, setOpenSession] = useState<SessionSummaryProps['sessionId'] | null>(null)
  const open = openSession === props.sessionId
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, gap: 8, margin: 12, align: 'end' })
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node
        && !panelRef.current?.contains(event.target)
        && !triggerRef.current?.contains(event.target)) setOpenSession(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setOpenSession(null)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  return <>
    <button ref={triggerRef} type="button" className={css.button} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setOpenSession(open ? null : props.sessionId) }}>Session summary</button>
    {open && createPortal(<div ref={panelRef} id={id} role="dialog" aria-label="Session summary" tabIndex={-1}
      className={css.popover} style={position ?? { visibility: 'hidden' }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node
          && !event.currentTarget.contains(event.relatedTarget)
          && !triggerRef.current?.contains(event.relatedTarget)) setOpenSession(null)
      }}>
      <SummaryContent {...props} />
    </div>, document.body)}
  </>
}
