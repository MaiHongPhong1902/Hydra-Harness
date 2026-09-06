/** Pure grouping of prompt revisions into one navigable conversation. */
import type { SessionId } from '@hydra/harness-api-remotes/client'
import type { SessionListState, SessionSummary } from './service.ts'

function compareVersions(a: SessionSummary, b: SessionSummary): number {
  return Number(a.revision !== undefined) - Number(b.revision !== undefined)
    || (a.revision?.createdAt ?? 0) - (b.revision?.createdAt ?? 0) || a.id.localeCompare(b.id)
}

/**
 * List the original conversation followed by its revisions in creation order.
 * @param list - current session list.
 * @param sessionId - any version of the conversation.
 * @returns available versions, oldest first.
 */
export function conversationVersions(list: SessionListState, sessionId: SessionId): SessionSummary[] {
  const root = list.byId[sessionId]?.revision?.conversationId ?? sessionId
  return list.ids.flatMap((id) => {
    const summary = list.byId[id]
    return summary !== undefined && (id === root || summary.revision?.conversationId === root) ? [summary] : []
  }).sort(compareVersions)
}

/**
 * Map every version to one sidebar row: the viewed version, otherwise the latest.
 * Archiving any member hides the conversation as a whole.
 * @param list - current session list and selection.
 * @param archived - archived session identities.
 * @returns representatives addressed by every member identity.
 */
export function conversationRepresentatives(
  list: SessionListState,
  archived: ReadonlySet<SessionId>,
): Map<SessionId, SessionSummary> {
  const groups = new Map<SessionId, SessionSummary[]>()
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary === undefined) continue
    const root = summary.revision?.conversationId ?? id
    const members = groups.get(root) ?? []
    members.push(summary)
    groups.set(root, members)
  }
  const result = new Map<SessionId, SessionSummary>()
  for (const members of groups.values()) {
    if (members.some(member => archived.has(member.id))) continue
    const selected = members.find(member => member.id === list.current)
    const latest = members.reduce((a, b) => compareVersions(a, b) > 0 ? a : b)
    for (const member of members) result.set(member.id, selected ?? latest)
  }
  return result
}
