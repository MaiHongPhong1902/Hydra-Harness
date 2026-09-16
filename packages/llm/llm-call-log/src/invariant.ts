/** Correlate diagnostic output and completion with their recorded model call. */

import type { Context } from '@hydra/cordis'
import type { Session, SessionEvent } from '@hydra/harness-session'
import type { InvariantFailure, InvariantInstaller } from '@hydra/harness-invariants'
import type {} from './types.ts'

/** Cordis companion identity. */
export const name = 'llm-call-log-invariant'
/** Registry owning this companion. */
export const inject = ['invariants']

function validate(session: Session, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'llm/call-first-output' && event.type !== 'llm/call-end') return
  const prior = session.events.filter(candidate => candidate.seq < event.seq)
  const start = prior.find(candidate => candidate.seq === event.data.callSeq)
  if (start?.type !== 'llm/call-start'
    || start.data.provider !== event.data.provider || start.data.model !== event.data.model) {
    fail('model call diagnostics must reference an earlier start with the same provider and model')
  }
  if (!Number.isFinite(event.data.elapsedMs) || event.data.elapsedMs < 0) {
    fail('model call elapsedMs must be finite and non-negative')
  }
  if (prior.some(candidate => (candidate.type === event.type || candidate.type === 'llm/call-end')
    && candidate.data.callSeq === event.data.callSeq)) {
    fail('model call diagnostics cannot repeat or follow their completion')
  }
  if (event.type === 'llm/call-end') {
    const first = prior.find(candidate => candidate.type === 'llm/call-first-output'
      && candidate.data.callSeq === event.data.callSeq)
    if (event.data.firstOutputMs !== (first?.type === 'llm/call-first-output' ? first.data.elapsedMs : undefined)
      || (event.data.firstOutputMs !== undefined && event.data.firstOutputMs > event.data.elapsedMs)
      || (event.data.firstTextMs !== undefined
        && (event.data.firstOutputMs === undefined || event.data.firstTextMs < event.data.firstOutputMs
          || event.data.firstTextMs > event.data.elapsedMs))) {
      fail('model call completion timing must agree with its first output')
    }
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const loaded = (session: Session): void => {
    for (const event of session.events) validate(session, event, fail)
  }
  for (const session of ctx.sessions.list()) {
    loaded(session)
  }
  ctx.on('session/created', loaded, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validate(session, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Install checks for live and restored diagnostic call records.
 * @param ctx - companion context with the invariant registry.
 * @returns disposer for the owned invariant registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@hydra/harness-llm-call-log', install))
