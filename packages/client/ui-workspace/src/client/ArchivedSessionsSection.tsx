/** Settings page for selecting, restoring, and deleting archived sessions. */
import { useEffect, useState } from 'react'
import {
  Button,
  IconArchiveOutline20, IconLoadingOutline16, IconRefreshOutline16, IconTrashOutline16,
} from '@hydra1902/harness-client-ui-primitives'
import type {
  SessionId, SessionListState, WorkspaceListState, WorkspaceView,
} from '@hydra1902/harness-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@hydra1902/harness-client-ui-slots'
// Type-only: pulls the settings.section SlotMap merge into this component's
// direct test and package programs.
import type {} from '@hydra1902/harness-client-ui-settings/client'
import css from './ArchivedSessionsSection.module.css'
import { DeleteSessionDialog } from './DeleteSessionDialog.tsx'

/** Registration-side action face for the Archived sessions settings page. */
export interface ArchivedSessionsSectionInjected {
  /** Remove a session from the archive set; its saved Workspace membership remains. */
  restoreSession: (sessionId: SessionId) => Promise<void>
  /** Permanently delete a session after confirmation. */
  deleteSession: (sessionId: SessionId) => Promise<void>
}

/** Full component props from the settings section slot and workspace locale. */
export type ArchivedSessionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'workspace'>
  & InjectFace<ArchivedSessionsSectionInjected>

interface ArchivedSessionRow {
  id: SessionId
  title: string
  workspace: WorkspaceView | undefined
  path: string | undefined
}

/** Preserve Host archive order while enriching each id with current metadata. */
function archivedRows(
  sessions: Pick<SessionListState, 'byId'>,
  workspaces: Pick<WorkspaceListState, 'items' | 'archivedSessionIds'>,
): ArchivedSessionRow[] {
  const workspaceBySession = new Map<SessionId, WorkspaceView>()
  for (const workspace of workspaces.items) {
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace)
  }
  return workspaces.archivedSessionIds.map((id) => {
    const session = sessions.byId[id]
    const workspace = workspaceBySession.get(id)
    return {
      id,
      title: session?.displayTitle ?? id,
      workspace,
      path: workspace?.path ?? session?.cwd,
    }
  })
}

/** Render archived sessions with individual and selected-session actions. */
export function ArchivedSessionsSection({
  useSessions, useWorkspaces, restoreSession, deleteSession, t,
}: ArchivedSessionsSectionProps) {
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  const rows = archivedRows(sessions, workspaces)
  const loading = workspaces.phase === 'pending' || sessions.phase === 'pending'
  const [restoring, setRestoring] = useState<SessionId | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [selected, setSelected] = useState<ReadonlySet<SessionId>>(new Set())
  const [deleteTargets, setDeleteTargets] = useState<readonly ArchivedSessionRow[] | null>(null)
  const selectedRows = rows.filter(row => selected.has(row.id))
  const busy = restoring !== undefined || deleteTargets !== null
  const allSelected = rows.length > 0 && selectedRows.length === rows.length

  useEffect(() => {
    const archived = new Set(workspaces.archivedSessionIds)
    setSelected(current => [...current].every(id => archived.has(id))
      ? current : new Set([...current].filter(id => archived.has(id))))
  }, [workspaces.archivedSessionIds])

  const deselect = (sessionId: SessionId): void => {
    setSelected((current) => {
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
  }

  const restore = async (targets: readonly ArchivedSessionRow[]): Promise<void> => {
    setError(undefined)
    const errors: string[] = []
    for (const target of targets) {
      setRestoring(target.id)
      try {
        await restoreSession(target.id)
        deselect(target.id)
      } catch (reason: unknown) {
        const detail = reason instanceof Error ? reason.message : String(reason)
        errors.push(`${t('archive.restoreError')}${targets.length > 1 ? ` (${target.title})` : ''}: ${detail}`)
      }
    }
    setError(errors.length === 0 ? undefined : errors.join('\n'))
    setRestoring(undefined)
  }

  return (
    <section className={css.section} aria-labelledby="settings-archive-title">
      <div className={css.heading}>
        <IconArchiveOutline20 size={20} />
        <h2 id="settings-archive-title" className={css.title}>{t('archive.title')}</h2>
      </div>
      <p className={css.description}>{t('archive.description')}</p>
      {error === undefined ? null : <p className={css.error} role="alert">{error}</p>}
      {loading
        ? <p className={css.empty}>{t('archive.loading')}</p>
        : rows.length === 0
          ? <p className={css.empty}>{t('archive.empty')}</p>
          : (
            <>
              <div className={css.toolbar}>
                <label className={css.selection}>
                  <input type="checkbox" checked={allSelected} disabled={busy}
                    ref={(input) => { if (input) input.indeterminate = selectedRows.length > 0 && !allSelected }}
                    onChange={(event) => { setSelected(new Set(event.target.checked ? rows.map(row => row.id) : [])) }} />
                  {t('archive.selectAll')}
                </label>
                <span role="status">{t('archive.selected', { n: selectedRows.length })}</span>
                {selectedRows.length === 0 ? null : (
                  <Button size="sm" disabled={busy} onClick={() => { setSelected(new Set()) }}>
                    {t('archive.clearSelection')}
                  </Button>
                )}
                <div className={css.actions}>
                  <Button variant="outline" size="sm" disabled={busy || selectedRows.length === 0}
                    onClick={() => { void restore(selectedRows) }}>
                    {t('archive.restoreSelected')}
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy || selectedRows.length === 0}
                    onClick={() => { setDeleteTargets(selectedRows) }}>
                    {t('archive.deleteSelected')}
                  </Button>
                </div>
              </div>
              <ul className={css.list}>
                {rows.map(row => (
                  <li key={row.id} className={css.row} data-selected={selected.has(row.id)}>
                    <label className={css.rowSelection}>
                      <input type="checkbox" checked={selected.has(row.id)} disabled={busy}
                        aria-label={t('archive.select', { name: row.title })}
                        onChange={(event) => {
                          const checked = event.target.checked
                          setSelected((current) => {
                            const next = new Set(current)
                            if (checked) next.add(row.id)
                            else next.delete(row.id)
                            return next
                          })
                        }} />
                      <span className={css.rowDetails}>
                        <strong className={css.sessionTitle}>{row.title}</strong>
                        <span className={css.workspaceTitle}>
                          {row.workspace?.title ?? t('archive.unknownWorkspace')}
                        </span>
                        {row.path === undefined ? null : <span className={css.path} title={row.path}>{row.path}</span>}
                      </span>
                    </label>
                    <div className={css.actions}>
                      <button
                        type="button"
                        className={css.restore}
                        disabled={busy}
                        aria-label={t('archive.restoreAria', { name: row.title })}
                        onClick={() => { void restore([row]) }}
                      >
                        {restoring === row.id
                          ? <IconLoadingOutline16 size={14} />
                          : <IconRefreshOutline16 size={14} />}
                        <span>{restoring === row.id ? t('archive.restoring') : t('archive.restore')}</span>
                      </button>
                      <button type="button" className={css.restore} disabled={busy}
                        aria-label={t('delete.session.aria', { name: row.title })}
                        onClick={() => { setDeleteTargets([row]) }}>
                        <IconTrashOutline16 size={14} />
                        <span>{t('delete.session')}</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
      {deleteTargets === null ? null : (
        <DeleteSessionDialog
          targets={deleteTargets}
          deleteSession={async (id) => { await deleteSession(id); deselect(id) }}
          onClose={() => { setDeleteTargets(null) }}
          t={t}
        />
      )}
    </section>
  )
}
