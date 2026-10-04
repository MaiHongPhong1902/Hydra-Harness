/** Sidebar organization changes presentation without changing a session's execution directory. */
import type { SessionId, WorkspaceView } from '@hydraharness/harness-client-runtime/client'

/** Persisted custom sections and pinned rows projected ahead of Workspace groups. */
export interface SessionOrganization {
  pinnedSessionIds: readonly string[]
  sections: readonly { id: string; title: string }[]
  sectionBySession: Readonly<Record<string, string>>
}

/**
 * Project browser-local grouping choices over the Host's directory accounts.
 * Deleted project targets fall back to Host membership.
 * @param workspaces - authoritative directory accounts.
 * @param assignments - explicit display project ids, or null for Ungrouped.
 * @param sessionIds - known session ids; stale assignments cannot mint rows.
 * @returns display accounts with each moved session in at most one project.
 */
export function displayProjects(
  workspaces: readonly WorkspaceView[], assignments: Readonly<Record<string, string | null>>, sessionIds: readonly SessionId[],
): readonly WorkspaceView[] {
  const projects = new Set(workspaces.map(workspace => workspace.workspaceId as string))
  const moved = new Set(Object.keys(assignments).filter(id => assignments[id] === null || projects.has(assignments[id] as string)))
  if (moved.size === 0) return workspaces
  return workspaces.map(workspace => ({
    ...workspace,
    sessionIds: [
      ...sessionIds.filter(id => moved.has(id) && assignments[id] === workspace.workspaceId),
      ...workspace.sessionIds.filter(id => !moved.has(id)),
    ],
  }))
}

/**
 * Determine whether a row is displayed in Pinned or a custom section.
 * @param id - session id.
 * @param organization - persisted organization choices.
 * @returns true when a visible organization group owns the row.
 */
export function isOrganized(id: string, organization: SessionOrganization): boolean {
  return organization.pinnedSessionIds.includes(id)
    || organization.sections.some(section => section.id === organization.sectionBySession[id])
}
