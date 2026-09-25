/** Persisted agent edit history and inline review actions. @module */
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { InjectFace, PropsRuntime } from '@hydra/harness-client-ui-slots'
import type { ReviewChange, ReviewHunk, ReviewMode, WorkspaceReviewFile } from '@hydra/harness-fs-review/client'
import type { ReviewHistory, ReviewSnapshot } from './history.ts'
import { DiffView } from './DiffView.tsx'
import css from './Review.module.css'

const cx = (...args: (string | boolean | undefined | null)[]): string => args.filter(Boolean).join(' ')

/** Business actions and observable supplied by the slot registration. */
export interface ReviewInjected {
  ownerSessionId: ReviewChange['sessionId']
  hooks: { review: ReviewHistory }
  act: ReviewHistory['act']
  refresh: ReviewHistory['refresh']
  refreshWorkspace?: ReviewHistory['refreshWorkspace']
}

function WorkspaceRow({ file, diffMode, wordWrap, wordDiffs, hideWhitespace, expanded }: {
  file: WorkspaceReviewFile
  diffMode: 'unified' | 'split'
  wordWrap: boolean
  wordDiffs: boolean
  hideWhitespace: boolean
  expanded: boolean
}) {
  const statusClass = file.status === 'added' ? css.statusAdded : file.status === 'deleted' ? css.statusDeleted : css.statusModified
  return <section className={css.change} aria-label={`${file.path} workspace ${file.status}`}>
    <details open={expanded}>
      <summary><span className={cx(css.statusBadge, statusClass)} aria-label={file.status}>{file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}</span><span className={css.filePath}>{file.path}</span><span className={css.additions}>+{file.additions}</span><span className={css.deletions}>−{file.deletions}</span><span className={css.state}>Workspace</span></summary>
      <div className={css.diffContainer}>{file.binary ? <p style={{ padding: '12px' }}>Binary file — text diff unavailable.</p> : file.truncated ? <p style={{ padding: '12px' }}>Diff exceeds the preview limit.</p> : file.hunks.length === 0 ? <p style={{ padding: '12px' }}>No line changes.</p> : <DiffView hunks={file.hunks} path={file.path} mode={diffMode} wordWrap={wordWrap} wordDiffs={wordDiffs} hideWhitespace={hideWhitespace} />}</div>
    </details>
  </section>
}

function getDiffText(hunks: readonly ReviewHunk[]): string {
  return hunks.map(h => `${h.header}\n${h.lines.join('\n')}`).join('\n')
}

type ReviewFile = ReviewChange | WorkspaceReviewFile

interface TreeFileNode {
  kind: 'file'
  name: string
  path: string
  change: ReviewFile
}

interface TreeFolderNode {
  kind: 'folder'
  name: string
  path: string
  children: (TreeFolderNode | TreeFileNode)[]
  hasPending: boolean
}

type TreeNode = TreeFolderNode | TreeFileNode

interface RawFolder {
  name: string
  path: string
  folders: Map<string, RawFolder>
  files: TreeFileNode[]
}

function buildTree(changes: readonly ReviewFile[]): TreeNode[] {
  const rootFolders = new Map<string, RawFolder>()
  const rootFiles: TreeFileNode[] = []

  for (const change of new Map(changes.map(change => [change.path, change])).values()) {
    const parts = change.path.split('/')
    if (parts.length === 1) {
      rootFiles.push({ kind: 'file', name: parts[0] as string, path: change.path, change })
      continue
    }

    let currentMap = rootFolders
    let currentPath = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] as string
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let folder = currentMap.get(part)
      if (!folder) {
        folder = { name: part, path: currentPath, folders: new Map(), files: [] }
        currentMap.set(part, folder)
      }
      if (i === parts.length - 2) {
        folder.files.push({
          kind: 'file',
          name: parts[parts.length - 1] as string,
          path: change.path,
          change,
        })
      } else {
        currentMap = folder.folders
      }
    }
  }

  function collapseAndConvert(raw: RawFolder): TreeFolderNode {
    let current = raw
    let combinedName = current.name
    let combinedPath = current.path
    while (current.files.length === 0 && current.folders.size === 1) {
      const next = current.folders.values().next().value as RawFolder
      combinedName = `${combinedName} / ${next.name}`
      combinedPath = next.path
      current = next
    }

    const folderChildren: TreeFolderNode[] = []
    for (const sub of current.folders.values()) {
      folderChildren.push(collapseAndConvert(sub))
    }
    const children: (TreeFolderNode | TreeFileNode)[] = [...folderChildren, ...current.files]

    const hasPending = children.some(c => c.kind === 'file'
      ? ('state' in c.change && c.change.state !== 'kept' && c.change.state !== 'rolledBack')
      : c.hasPending)

    return {
      kind: 'folder',
      name: combinedName,
      path: combinedPath,
      children,
      hasPending,
    }
  }

  const result: TreeNode[] = []
  for (const f of rootFolders.values()) {
    result.push(collapseAndConvert(f))
  }
  for (const file of rootFiles) {
    result.push(file)
  }
  return result
}

function FileTreeView({
  nodes,
  selectedPath,
  onSelectPath,
  collapsedFolders,
  onToggleFolder,
  depth = 0,
}: {
  nodes: readonly TreeNode[]
  selectedPath: string | undefined
  onSelectPath: (path: string) => void
  collapsedFolders: ReadonlySet<string>
  onToggleFolder: (path: string) => void
  depth?: number
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'folder') {
          const isCollapsed = collapsedFolders.has(node.path)
          return (
            <div key={node.path} role="treeitem" aria-expanded={!isCollapsed}>
              <button
                type="button"
                className={css.folderRow}
                style={{ paddingLeft: `${depth * 14 + 6}px` }}
                onClick={() => { onToggleFolder(node.path) }}
                aria-expanded={!isCollapsed}
                title={node.name}
              >
                <span className={css.folderChevron} aria-hidden="true">
                  {isCollapsed ? (
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  )}
                </span>
                <span className={css.folderName}>{node.name}</span>
                {node.hasPending && <span className={css.pendingDot} aria-hidden="true" />}
              </button>
              {!isCollapsed && (
                <div role="group">
                  <FileTreeView
                    nodes={node.children}
                    selectedPath={selectedPath}
                    onSelectPath={onSelectPath}
                    collapsedFolders={collapsedFolders}
                    onToggleFolder={onToggleFolder}
                    depth={depth + 1}
                  />
                </div>
              )}
            </div>
          )
        }

        const isSelected = selectedPath === node.path
        const statusLetter = ({ added: 'A', modified: 'M', deleted: 'D' })[node.change.status]
        const statusClass = node.change.status === 'added' ? css.statusAdded : node.change.status === 'deleted' ? css.statusDeleted : css.statusModified
        const isDone = 'state' in node.change && node.change.state === 'rolledBack'
        const isAdd = node.change.status === 'added'

        return (
          <button
            key={node.path}
            type="button"
            role="treeitem"
            aria-selected={isSelected}
            className={cx(css.fileRow, isSelected && css.fileRowActive)}
            style={{ paddingLeft: `${depth * 14 + 6}px` }}
            onClick={() => { onSelectPath(node.path) }}
            title={node.path}
          >
            <span className={cx(css.treeBadge, statusClass)} aria-label={node.change.status}>
              {statusLetter}
              {node.change.status === 'modified' && <span className={css.badgeArrow} aria-hidden="true">↓</span>}
            </span>
            <span className={css.fileName}>{node.name}</span>
            <span className={css.treeIndicator} aria-hidden="true">
              {isDone && <span className={css.treeIconUndone}>U</span>}
              {isAdd && <span className={css.treeIconAdd}>+</span>}
              {!isDone && !isAdd && <span className={css.treeIconBox}>⊡</span>}
            </span>
          </button>
        )
      })}
    </>
  )
}

/** One historical mutation with recorded hunks and safe host-side actions. */
export function ChangeRow({ change, pending, act, diffMode = 'unified', wordWrap = false, wordDiffs = true, hideWhitespace = false, expanded, onToggle }: {
  change: ReviewChange
  pending: boolean
  act: ReviewHistory['act']
  diffMode?: 'unified' | 'split'
  wordWrap?: boolean
  wordDiffs?: boolean
  hideWhitespace?: boolean
  expanded?: boolean
  onToggle?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const completed = change.state === 'rolledBack'
  const uncertain = change.state === 'pending' || change.state === 'undoing'
  const statusLetter = ({ added: 'A', modified: 'M', deleted: 'D' })[change.status]
  const statusClass = change.status === 'added' ? css.statusAdded : change.status === 'deleted' ? css.statusDeleted : css.statusModified

  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation()
    const text = getDiffText(change.hunks)
    if (!text) return
    setCopyError(false)
    void Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1500)
    }, () => { setCopyError(true) })
  }

  return (
    <section className={css.change} aria-label={`${change.path} ${change.state}`}>
      <details open={expanded} onToggle={onToggle}>
        <summary>
          <span className={cx(css.statusBadge, statusClass)} aria-label={change.status}>
            {statusLetter}
            {change.status === 'modified' && <span className={css.badgeArrow} aria-hidden="true">↓</span>}
          </span>
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
                <DiffView
                  hunks={change.hunks}
                  path={change.path}
                  mode={diffMode}
                  wordWrap={wordWrap}
                  wordDiffs={wordDiffs}
                  hideWhitespace={hideWhitespace}
                />
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
          disabled={pending || completed || uncertain || change.binary || change.truncated || change.hunks.length === 0}
          title="Copy diff to clipboard"
        >
          {copied ? 'Copied!' : 'Copy diff'}
        </button>
        {!change.reversible || uncertain ? <span>Undo unavailable</span> : null}
        {copyError && <span role="alert">Clipboard access failed.</span>}
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
      {snapshot.error ? <p role="alert" className={css.errorAlert}>{snapshot.error}</p> : null}
      {changes.map(change => <ChangeRow key={change.id} change={change} pending={snapshot.pending.has(change.id)} act={act} />)}
    </div>
  )
}

/** Review panel occupying the desktop right panel's Review seat. */
export function ReviewPanel({ useReview, act, refresh, ownerSessionId, useWorkspaces, refreshWorkspace }: PropsRuntime<'review'> & InjectFace<ReviewInjected>) {
  const snapshot = useReview(value => value)
  const mounted = typeof useWorkspaces === 'function' ? useWorkspaces(state => state.items.find(item => item.sessionIds.includes(ownerSessionId))) : undefined
  const [scope, setScope] = useState<'session' | ReviewMode>('session')
  const [reference, setReference] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'pending' | 'kept' | 'undone'>('all')
  const [showSidebar, setShowSidebar] = useState(true)
  const [singleFile, setSingleFile] = useState(false)
  const [diffMode, setDiffMode] = useState<'unified' | 'split'>('unified')
  const [wordWrap, setWordWrap] = useState(false)
  const [wordDiffs, setWordDiffs] = useState(true)
  const [fullContext, setFullContext] = useState(false)
  const [hideWhitespace, setHideWhitespace] = useState(false)
  const [expansion, setExpansion] = useState({ open: false, revision: 0 })
  const [selectedPath, setSelectedPath] = useState<string | undefined>()
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const mode = scope === 'session' ? 'uncommitted' : scope
  useEffect(() => { if (refreshWorkspace !== undefined) void refreshWorkspace(mode, reference || undefined, fullContext) },
    [refreshWorkspace, mode, reference, fullContext])
  const workspace = snapshot.workspace
  const workspacePath = workspace?.workspace ?? mounted?.path
  const changes = useMemo(() => snapshot.changes.filter(change =>
    workspacePath === undefined || sameWorkspace(change.workspace, workspacePath)), [snapshot.changes, workspacePath])
  const counts = {
    pending: changes.filter(change => change.state === 'active').length,
    kept: changes.filter(change => change.state === 'kept').length,
    undone: changes.filter(change => change.state === 'rolledBack').length,
  }
  const evidence: readonly ReviewFile[] = scope === 'session' ? changes
    : snapshot.workspaceLoading || snapshot.workspaceError ? [] : workspace?.files ?? []
  const filtered = evidence.filter((file) => {
    if (!file.path.toLowerCase().includes(search.trim().toLowerCase())) return false
    if (scope !== 'session' || filter === 'all') return true
    return 'state' in file && file.state === ({ pending: 'active', kept: 'kept', undone: 'rolledBack' } as const)[filter]
  })
  const paths = [...new Set(filtered.map(file => file.path))]
  const selected = selectedPath !== undefined && paths.includes(selectedPath) ? selectedPath : paths[0]
  const currentIndex = selected === undefined ? -1 : paths.indexOf(selected)
  const active = singleFile ? filtered.filter(file => file.path === selected) : filtered
  const additions = evidence.reduce((sum, file) => sum + file.additions, 0)
  const deletions = evidence.reduce((sum, file) => sum + file.deletions, 0)
  const fileCount = new Set(evidence.map(file => file.path)).size
  const loading = scope === 'session' ? snapshot.loading : snapshot.workspaceLoading
  const error = scope === 'session' ? snapshot.error : snapshot.workspaceError
  const diffOptions = { diffMode, wordWrap, wordDiffs, hideWhitespace, expanded: expansion.open }
  const keepable = changes.filter(change => change.state === 'active')
  const undoable = changes.filter(change => change.reversible && (change.state === 'active' || change.state === 'kept')).reverse()
  const batch = async (targets: readonly ReviewChange[], action: 'keep' | 'undo') => {
    for (const change of targets) if (!await act(change, action)) break
  }
  const copyPatch = async () => {
    const patch = filtered.filter((file): file is WorkspaceReviewFile => 'patch' in file).map(file => file.patch ?? '').join('')
    try { await navigator.clipboard.writeText(patch) }
    catch { setNotice('Clipboard access failed.'); return }
    setNotice('Patch copied.')
  }
  return (
    <section className={css.panel} aria-label="Review">
      <header className={css.headerArea}>
        <div className={css.topHeader}>
          <div className={css.headerLeft}>
            <strong className={css.panelTitle}>Review</strong>
            <span title={workspacePath}>{mounted?.title ?? workspacePath ?? 'Workspace unavailable'}</span>
            <span className={css.panelSubtitle}>{evidence.length} changes · {fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
            <span className={css.statAdd}>+{additions}</span><span className={css.statDel}>−{deletions}</span>
          </div>
          <div className={css.headerRight}>
            <button type="button" onClick={() => { void refresh() }}>Refresh</button>
            {scope === 'session' && <>
              <button type="button" className={css.btnKeep} disabled={keepable.length === 0 || snapshot.pending.size > 0} onClick={() => { void batch(keepable, 'keep') }}>Keep All</button>
              <button type="button" className={css.btnUndo} disabled={undoable.length === 0 || snapshot.pending.size > 0} onClick={() => { void batch(undoable, 'undo') }}>Undo All</button>
            </>}
          </div>
        </div>
        <div className={css.subBar}>
          <select data-hydra-control="compact" aria-label="Review scope" className={css.branchSelect} value={scope} onChange={(event) => { setScope(event.target.value as typeof scope); setReference(''); setSelectedPath(undefined); setNotice(null) }}>
            <option value="session">Session changes</option><option value="uncommitted">Uncommitted changes</option>
            <option value="unstaged">Unstaged changes</option><option value="staged">Staged changes</option>
            <option value="committed">Commit</option><option value="branch">Branch comparison</option>
          </select>
          {scope === 'branch' && <select data-hydra-control="compact" aria-label="Base branch" className={css.branchSelect} value={reference} onChange={(event) => { setReference(event.target.value) }}>
            <option value="">Select base branch</option>{workspace?.branches.map(branch => <option key={branch} value={branch}>{branch.replace(/^refs\/(heads|remotes)\//u, '')}</option>)}
          </select>}
          {scope === 'committed' && <select data-hydra-control="compact" aria-label="Commit" className={css.branchSelect} value={reference} onChange={(event) => { setReference(event.target.value) }}>
            <option value="">Latest commit</option>{workspace?.commits.map(item => <option key={item.oid} value={item.oid}>{item.oid.slice(0, 7)} {item.subject}</option>)}
          </select>}
          {workspace?.branch && <span className={css.subBarBranch}>{workspace.branch}</span>}
        </div>
        <div className={css.toolbar}>
          <button type="button" aria-label="Toggle file list" aria-pressed={showSidebar} onClick={() => { setShowSidebar(value => !value) }}>Files</button>
          <button type="button" aria-label="Toggle view mode" onClick={() => { setSingleFile(value => !value) }}>{singleFile ? 'All files' : 'One file'}</button>
          <button type="button" aria-label={expansion.open ? 'Collapse all diffs' : 'Expand all diffs'} onClick={() => { setExpansion(value => ({ open: !value.open, revision: value.revision + 1 })) }}>{expansion.open ? 'Collapse all' : 'Expand all'}</button>
          <details className={css.preferences}>
            <summary>Diff preferences</summary>
            <div className={css.popover}>
              <label className={css.prefRow}>
                <span>Diff layout</span>
                <select data-hydra-control="compact" aria-label="Diff layout" value={diffMode} onChange={(event) => { setDiffMode(event.target.value as typeof diffMode) }}>
                  <option value="unified">Unified</option>
                  <option value="split">Split</option>
                </select>
              </label>
              <label className={css.checkboxLabel}><input type="checkbox" checked={wordWrap} onChange={(event) => { setWordWrap(event.target.checked) }} /> Word wrap</label>
              <label className={css.checkboxLabel}><input type="checkbox" checked={wordDiffs} onChange={(event) => { setWordDiffs(event.target.checked) }} /> Word diffs</label>
              <label className={css.checkboxLabel}><input type="checkbox" checked={hideWhitespace} onChange={(event) => { setHideWhitespace(event.target.checked) }} /> Hide whitespace changes</label>
              {scope !== 'session' && <label className={css.checkboxLabel}><input type="checkbox" checked={fullContext} onChange={(event) => { setFullContext(event.target.checked) }} /> Full file context</label>}
            </div>
          </details>
          {scope !== 'session' && <button type="button" disabled={filtered.length === 0 || filtered.some(file => 'patch' in file && (file.patch === null || file.truncated)) || workspace?.truncated === true} onClick={() => { void copyPatch() }}>Copy patch</button>}
        </div>
      </header>
      {paths.length > 0 && <div className={css.banner}>
        <span>{singleFile ? 'Showing one file at a time' : `Showing all ${paths.length} changed files`}</span>
        {singleFile && <div className={css.bannerNav}>
          <button type="button" className={css.bannerNavBtn} aria-label="Previous file" disabled={currentIndex <= 0} onClick={() => { setSelectedPath(paths[currentIndex - 1]) }}>‹</button>
          <span className={css.bannerNavCount}>{currentIndex + 1} of {paths.length}</span>
          <button type="button" className={css.bannerNavBtn} aria-label="Next file" disabled={currentIndex >= paths.length - 1} onClick={() => { setSelectedPath(paths[currentIndex + 1]) }}>›</button>
        </div>}
      </div>}
      <div className={css.workspace}>
        <div className={css.diffPane}>
          {loading && <p role="status">Loading changes…</p>}
          {error && <p role="alert" className={css.errorAlert}>{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {!loading && !error && evidence.length === 0 && <p>{scope === 'session' ? 'No agent file changes in this session.' : workspace?.repository === null ? 'This session workspace is not a Git repository.' : 'No changes in this comparison.'}</p>}
          {scope !== 'session' && workspace?.truncated && <p role="status">Showing a limited number of files. Narrow the comparison to review the remaining files.</p>}
          {evidence.length > 0 && filtered.length === 0 && <p>No changes match the selected filters.</p>}
          <div className={css.rows}>{active.map(file => 'state' in file
            ? <ChangeRow key={`${file.id}:${expansion.revision}`} change={file} pending={snapshot.pending.has(file.id)} act={act} {...diffOptions} />
            : <WorkspaceRow key={`${file.path}:${expansion.revision}`} file={file} {...diffOptions} />)}</div>
        </div>
        {showSidebar && evidence.length > 0 && <aside className={css.sidebarPane} aria-label="Changed files">
          <div className={css.sidebarSearchWrap}>
            <div className={css.searchBoxWrap}>
              <span className={css.searchIcon} aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <path d="M7 12C9.76142 12 12 9.76142 12 7C12 4.23858 9.76142 2 7 2C4.23858 2 2 4.23858 2 7C2 9.76142 4.23858 12 7 12Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
              <input data-hydra-control="compact" type="search" className={css.searchBox} placeholder="Filter files..." aria-label="Filter changes by file" value={search} onChange={(event) => { setSearch(event.target.value) }} />
            </div>
            {scope === 'session' && <div className={css.filterTabs} role="tablist" aria-label="Filter status" onKeyDown={(event) => {
              const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
              const index = tabs.indexOf(event.target as HTMLButtonElement)
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
              if (next < 0) return
              event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click()
            }}>
              {(['all', 'pending', 'kept', 'undone'] as const).map(status => <button key={status} type="button" role="tab" aria-selected={filter === status} tabIndex={filter === status ? 0 : -1} className={cx(css.filterTab, filter === status && css.filterTabActive)} onClick={() => { setFilter(status) }}>{status.charAt(0).toUpperCase() + status.slice(1)} ({status === 'all' ? changes.length : counts[status]})</button>)}
            </div>}
          </div>
          <div className={css.treeView} role="tree" aria-label="File changes">
            <FileTreeView
              nodes={buildTree(filtered)} selectedPath={selected}
              onSelectPath={(path) => { setSelectedPath(path); setSingleFile(true) }}
              collapsedFolders={collapsedFolders}
              onToggleFolder={(path) => {
                setCollapsedFolders((previous) => {
                  const next = new Set(previous)
                  if (!next.delete(path)) next.add(path)
                  return next
                })
              }}
            />
          </div>
        </aside>}
      </div>
    </section>
  )
}

/**
 * Compare workspace paths with Windows drive case folding and trailing separator normalization.
 * @param left - first recorded workspace path.
 * @param right - second recorded workspace path.
 * @returns whether both paths identify the same workspace spelling.
 */
export function sameWorkspace(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/gu, '/').replace(/\/$/u, '')
    return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

/** The same evidence and actions next to the owning Write/Edit tool result. */
export function InlineReview({ callId, useReview, act, ownerSessionId }: PropsRuntime<'tool.call.review'> & InjectFace<ReviewInjected>) {
  return <HistoryRows snapshot={useReview(value => value)} act={act} callId={callId} ownerSessionId={ownerSessionId} />
}
