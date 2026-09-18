/** Settings page for restoring sessions hidden by the workspace archive. */
import { useState } from 'react'
import {
  IconArchiveOutline20, IconLoadingOutline16, IconRefreshOutline16, IconTrashOutline16,
} from '@hydra/harness-client-ui-primitives'
import type {
  SessionId, SessionListState, WorkspaceListState, WorkspaceView,
} from '@hydra/harness-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@hydra/harness-client-ui-slots'
// Type-only: pulls the settings.section SlotMap merge into this component's
// direct test and package programs.
import type {} from '@hydra/harness-client-ui-settings/client'
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

/** Render archived sessions and restore each one to its retained Workspace. */
export function ArchivedSessionsSection({
  useSessions, useWorkspaces, restoreSession, deleteSession, t,
}: ArchivedSessionsSectionProps) {
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  const rows = archivedRows(sessions, workspaces)
  const loading = workspaces.phase === 'pending' || sessions.phase === 'pending'
  const [restoring, setRestoring] = useState<SessionId | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<{ id: SessionId; title: string } | null>(null)

  const restore = async (sessionId: SessionId): Promise<void> => {
    setRestoring(sessionId)
    setError(undefined)
    try {
      await restoreSession(sessionId)
    } catch (reason: unknown) {
      const detail = reason instanceof Error ? reason.message : String(reason)
      setError(`${t('archive.restoreError')}: ${detail}`)
    } finally {
      setRestoring(undefined)
    }
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
            <ul className={css.list}>
              {rows.map(row => (
                <li key={row.id} className={css.row}>
                  <div className={css.rowDetails}>
                    <strong className={css.sessionTitle}>{row.title}</strong>
                    <span className={css.workspaceTitle}>
                      {row.workspace?.title ?? t('archive.unknownWorkspace')}
                    </span>
                    {row.path === undefined ? null : <span className={css.path} title={row.path}>{row.path}</span>}
                  </div>
                  <button
                    type="button"
                    className={css.restore}
                    disabled={restoring !== undefined}
                    aria-label={t('archive.restoreAria', { name: row.title })}
                    onClick={() => { void restore(row.id) }}
                  >
                    {restoring === row.id
                      ? <IconLoadingOutline16 size={14} />
                      : <IconRefreshOutline16 size={14} />}
                    <span>{restoring === row.id ? t('archive.restoring') : t('archive.restore')}</span>
                  </button>
                  <button type="button" className={css.restore} disabled={restoring !== undefined}
                    aria-label={t('delete.session.aria', { name: row.title })}
                    onClick={() => { setDeleteTarget({ id: row.id, title: row.title }) }}>
                    <IconTrashOutline16 size={14} />
                    <span>{t('delete.session')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      {deleteTarget === null ? null : (
        <DeleteSessionDialog
          target={deleteTarget}
          deleteSession={deleteSession}
          onClose={() => { setDeleteTarget(null) }}
          t={t}
        />
      )}
    </section>
  )
}
