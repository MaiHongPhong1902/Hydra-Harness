/** Pure grouping of prompt revisions into one navigable conversation. */
import type { SessionId } from '@hydraharness/harness-api-remotes/client'
import type { SessionVersionId } from '@hydraharness/harness-session/types'
import type { SessionListState, SessionSummary } from './service.ts'

/** A stored transcript path, with its selection state and owning session. */
export type ConversationVersion = Omit<SessionSummary, 'id'> & { id: SessionId | SessionVersionId; selected?: boolean }

function compareVersions(a: SessionSummary, b: SessionSummary): number {
  return Number(a.revision !== undefined) - Number(b.revision !== undefined)
    || (a.revision?.createdAt ?? 0) - (b.revision?.createdAt ?? 0)
    || (a.revision?.attempt ?? 1) - (b.revision?.attempt ?? 1) || a.id.localeCompare(b.id)
}

/**
 * List the original conversation followed by its revisions in creation order.
 * @param list - current session list.
 * @param sessionId - any version of the conversation.
 * @returns available versions, oldest first.
 */
export function conversationVersions(list: SessionListState, sessionId: SessionId): ConversationVersion[] {
  const summary = list.byId[sessionId]
  if (summary?.versionState !== undefined) {
    const { revision: _revision, ...base } = summary
    return summary.versionState.versions.map(version => ({ ...base, id: version.id,
      selected: version.id === summary.versionState?.current,
      ...version.revision === undefined ? {} : { revision: version.revision },
    }))
  }
  const root = list.byId[sessionId]?.revision?.conversationId ?? sessionId
  const attempts = list.ids.flatMap((id) => {
    const summary = list.byId[id]
    return summary !== undefined && (id === root || summary.revision?.conversationId === root) ? [summary] : []
  })
  const revisions = new Map<SessionId, SessionSummary>()
  for (const attempt of attempts) {
    const id = attempt.revision?.revisionId ?? attempt.id
    const previous = revisions.get(id)
    if (previous === undefined || attempt.id === sessionId
      || (previous.id !== sessionId && (attempt.revision?.attempt ?? 1) > (previous.revision?.attempt ?? 1))) revisions.set(id, attempt)
  }
  return [...revisions.values()].sort(compareVersions)
}

/**
 * Map every version to one sidebar row: current, last viewed, otherwise latest.
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
  for (const [root, members] of groups) {
    if (members.some(member => archived.has(member.id))) continue
    const selected = members.find(member => member.id === list.current)
    const remembered = members.find(member => member.id === list.viewedVersions?.[root])
    const latest = members.reduce((a, b) => compareVersions(a, b) > 0 ? a : b)
    for (const member of members) result.set(member.id, selected ?? remembered ?? latest)
  }
  return result
}
