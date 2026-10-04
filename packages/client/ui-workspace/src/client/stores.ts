/**
 * The workspace browser's viewing store: the session-list grouping mode,
 * persisted across reloads. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * register() receives the factory and the browser derives its PropsStore
 * share from the return type.
 */
import { defineStore, type EngineStoreHandle } from '@hydraharness/harness-client-runtime/client'

/** Browser-local order account for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

/** Session-list grouping mode: workspace sections or one flat recency list. */
export type SessionGroupBy = 'workspace' | 'flat'
/** Session order: user-arranged only, or user-arranged plus activity promotion. */
export type SessionOrderBy = 'manual' | 'updated'

/** Workspace browser viewing state persisted across surface remounts and reloads. */
type WorkspaceViewState = {
  pinnedSessionIds?: string[]
  unreadSessionIds?: string[]
  sections?: { id: string; title: string }[]
  sectionBySession?: Record<string, string>
  projectBySession?: Record<string, string | null>
  groupBy: SessionGroupBy
  orderBy: SessionOrderBy
  /** Explicit zero-or-five-session state keyed by Workspace group identity. */
  groupExpansion: Record<string, boolean>
  /** Shared editable order per Workspace group plus the browser-local flat-list account. */
  sessionOrderByAccount: Record<string, string[]>
  /** Last observed update timestamps per order account for one-time promotion events. */
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type WorkspaceViewActions = {
  togglePinned: (draft: WorkspaceViewState, id: string) => void
  setUnread: (draft: WorkspaceViewState, id: string, unread: boolean) => void
  addSection: (draft: WorkspaceViewState, id: string, title: string, sessionId: string) => void
  setSection: (draft: WorkspaceViewState, sessionId: string, sectionId: string | null) => void
  setProject: (draft: WorkspaceViewState, sessionId: string, workspaceId: string | null) => void
  setGroupBy: (draft: WorkspaceViewState, mode: SessionGroupBy) => void
  setOrderBy: (draft: WorkspaceViewState, mode: SessionOrderBy) => void
  setGroupExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void
  retainAccountKeys: (draft: WorkspaceViewState, workspaceKeys: readonly string[]) => void
  syncSessionOrderAccount: (
    draft: WorkspaceViewState,
    accountKey: string,
    order: string[],
    updatedAt: Record<string, number>,
  ) => void
  setSessionOrder: (draft: WorkspaceViewState, accountKey: string, order: string[]) => void
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<WorkspaceViewState, WorkspaceViewActions> {
  return defineStore({
    init: (): WorkspaceViewState => ({
      pinnedSessionIds: [],
      unreadSessionIds: [],
      sections: [],
      sectionBySession: {},
      projectBySession: {},
      groupBy: 'workspace',
      orderBy: 'updated',
      groupExpansion: {},
      sessionOrderByAccount: {},
      sessionUpdatedAtByAccount: {},
    }),
    persist: 'hydra.workspace.view.v5',
    actions: {
      togglePinned: (d, id: string) => {
        const pinned = d.pinnedSessionIds ?? []
        d.pinnedSessionIds = pinned.includes(id)
          ? pinned.filter(value => value !== id) : [...pinned, id]
      },
      setUnread: (d, id: string, unread: boolean) => {
        d.unreadSessionIds = (d.unreadSessionIds ?? []).filter(value => value !== id)
        if (unread) d.unreadSessionIds.push(id)
      },
      addSection: (d, id: string, title: string, sessionId: string) => {
        const sections = d.sections ??= []
        sections.push({ id, title })
        const assignments = d.sectionBySession ??= {}
        assignments[sessionId] = id
      },
      setSection: (d, sessionId: string, sectionId: string | null) => {
        const assignments = d.sectionBySession ??= {}
        if (sectionId === null) d.sectionBySession = Object.fromEntries(Object.entries(assignments).filter(([key]) => key !== sessionId))
        else assignments[sessionId] = sectionId
      },
      setProject: (d, sessionId: string, workspaceId: string | null) => {
        const assignments = d.projectBySession ??= {}
        assignments[sessionId] = workspaceId
      },
      setGroupBy: (d, mode: SessionGroupBy) => { d.groupBy = mode },
      setOrderBy: (d, mode: SessionOrderBy) => { d.orderBy = mode },
      setGroupExpanded: (d, key: string, expanded: boolean) => { d.groupExpansion[key] = expanded },
      retainAccountKeys: (d, workspaceKeys: readonly string[]) => {
        const retained = new Set(workspaceKeys)
        d.groupExpansion = Object.fromEntries(
          Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)),
        )
        d.sessionOrderByAccount = Object.fromEntries(
          Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)),
        )
        d.sessionUpdatedAtByAccount = Object.fromEntries(
          Object.entries(d.sessionUpdatedAtByAccount).filter(([key]) => retained.has(key)),
        )
      },
      syncSessionOrderAccount: (d, accountKey: string, order: string[], updatedAt: Record<string, number>) => {
        d.sessionOrderByAccount[accountKey] = order
        d.sessionUpdatedAtByAccount[accountKey] = updatedAt
      },
      setSessionOrder: (d, accountKey: string, order: string[]) => {
        d.sessionOrderByAccount[accountKey] = order
      },
    },
  })
}
