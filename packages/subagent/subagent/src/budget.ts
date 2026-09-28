/** Durable delegation admissions and process-local capacity shared by one session tree. */
import type { Context } from '@hydraharness/cordis'
import type { Agent } from '@hydraharness/harness-agent'
import type { Session } from '@hydraharness/harness-session'
import { SubagentError } from './error.ts'

declare module '@hydraharness/harness-session/types' {
  interface SessionEventMap {
    /** One admitted child creation, charged to the delegation root before provider work starts. */
    'subagent/admission': { parentId: Session['id'] }
  }
}

/**
 * Resolve the live root whose log owns a tree's cumulative budgets.
 * @param ctx - context with the session store.
 * @param agent - current caller.
 * @returns the root session; refuses a detached child whose ancestry cannot be established.
 */
export function delegationRoot(ctx: Context, agent: Agent): Session {
  let session = agent.session
  const visited = new Set<string>()
  while (session.header.origin === 'subagent') {
    if (visited.has(session.id)) throw new SubagentError('cyclic delegation ancestry', 'BUDGET_ANCESTRY_UNAVAILABLE')
    visited.add(session.id)
    const parent = session.header.parentSession === undefined ? undefined : ctx.get('sessions')?.get(session.header.parentSession)
    if (parent === undefined) throw new SubagentError('delegation budget requires the live parent session', 'BUDGET_ANCESTRY_UNAVAILABLE')
    session = parent
  }
  return session
}

/** Tree admission bounds, supplied explicitly by the deployment. */
export interface DelegationLimits {
  /** Maximum simultaneous child residencies and pending starts per root. */
  maxActivePerTree?: number
  /** Maximum cumulative child creation attempts per root session, including failed attempts. */
  maxChildrenPerTree?: number
}

/**
 * Reserve capacity before asynchronous setup; a release belongs to the run's settlement.
 * @param ctx - service context.
 * @param limits - optional configured caps.
 * @returns synchronous admission function with an idempotent release.
 */
export function delegationAdmission(ctx: Context, limits: DelegationLimits): (parent: Agent, creating: boolean) => () => void {
  for (const value of Object.values(limits)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('subagent limits must be positive safe integers')
  }
  const active = new WeakMap<Session, Set<object>>()
  return (parent, creating) => {
    if (limits.maxActivePerTree === undefined && limits.maxChildrenPerTree === undefined) return () => {}
    const root = delegationRoot(ctx, parent)
    const slots = active.get(root) ?? new Set<object>()
    if (limits.maxActivePerTree !== undefined && slots.size >= limits.maxActivePerTree) {
      throw new SubagentError('delegation tree is at its active child limit; wait for a child to settle', 'SUBAGENT_CAPACITY')
    }
    if (creating && limits.maxChildrenPerTree !== undefined) {
      const used = root.events.filter(event => event.type === 'subagent/admission').length
      if (used >= limits.maxChildrenPerTree) throw new SubagentError('delegation tree exhausted its child creation budget', 'SUBAGENT_BUDGET_EXHAUSTED')
      root.append('subagent/admission', { parentId: parent.id })
    }
    const slot = {}
    slots.add(slot)
    active.set(root, slots)
    return () => { slots.delete(slot) }
  }
}
