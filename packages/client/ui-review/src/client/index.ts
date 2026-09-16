/** Register the desktop Review panel and inline tool-call evidence over one shared data source. @module */
import type { ClientContext, SessionId } from '@hydra/harness-client-runtime/client'
import type { ConnectionHandle } from '@hydra/harness-client-connection/client'
import type {} from '@hydra/harness-api-remotes/client'
import type {} from '@hydra/harness-client-ui-layout/client'
import type {} from '@hydra/harness-client-ui-tool/client'
import type {} from '@hydra/harness-client-ui-conversation/client'
import { ReviewHistory } from './history.ts'
import { InlineReview, ReviewPanel, type ReviewInjected } from './Review.tsx'
import { SessionSummaryAction, type SessionSummaryInjected } from './SessionSummary.tsx'

/** Slot and transport dependencies used by the review plugin. */
export const inject = ['slots', 'connection', 'remote']

/**
 * Install shared history sources, remote invalidation, and both render entries.
 * @param ctx - browser plugin context; disposal closes every data source.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const histories = new Map<SessionId, ReviewHistory>()
  const injected = (id: SessionId): ReviewInjected => {
    let history = histories.get(id)
    if (!history) {
      history = new ReviewHistory(id, connection.api.review)
      histories.set(id, history)
    }
    return {
      ownerSessionId: id, hooks: { review: history }, act: history.act,
      refresh: history.refresh, refreshWorkspace: history.refreshWorkspace,
    }
  }
  ctx.effect(() => ctx.remote.$on('file-review/changed', () => {
    for (const history of histories.values()) void history.refresh()
  }))
  ctx.on('connection/reset', () => { for (const history of histories.values()) void history.refresh() })
  ctx.effect(() => () => { for (const history of histories.values()) history.dispose(); histories.clear() })
  ctx.slots.inject('review', () => ctx.slots.register({
    name: 'review', inject: injected,
  }, ReviewPanel))
  ctx.slots.inject('tool.call.review', () => ctx.slots.register({
    name: 'tool.call.review', id: 'review', inject: injected,
  }, InlineReview))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'session-summary', order: -1,
    inject: (id: SessionId): SessionSummaryInjected => {
      const review = injected(id)
      return { ...review, hooks: { ...review.hooks, hostDescription: connection.hostDescription } }
    },
  }, SessionSummaryAction))
}
