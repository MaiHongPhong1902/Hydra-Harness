/** Durable research budgets shared by one delegation root, enforced before tool dispatch. */
import type { Context } from '@hydra/cordis'
import z from '@hydra/schemastery'
import { delegationRoot } from '@hydra/harness-subagent'
import { HarnessError } from '@hydra/harness-llm'
import { deadline, timeoutOf } from '@hydra/harness-timeout'

/** Cordis plugin name. */
export const name = 'research-policy'
/** The registry and durable root session store. */
export const inject = ['tools', 'sessions']

/** Deployment bounds for one root session, including resumed turns and descendants. */
export interface Config {
  /** Maximum admitted search tool calls per root session. */
  maxSearchCalls?: number
  /** Maximum distinct query strings summed across admitted search calls. */
  maxQueries?: number
  /** Maximum fetch tool calls per root session. */
  maxFetches?: number
  /** Maximum browser tool calls per root session. */
  maxBrowserCalls?: number
  /** Wall-clock milliseconds since the first research admission; time continues while idle. */
  maxDurationMs?: number
}
export const Config: z<Config> = z.object({
  maxSearchCalls: z.number(), maxQueries: z.number(), maxFetches: z.number(), maxBrowserCalls: z.number(), maxDurationMs: z.number(),
})

declare module '@hydra/harness-session/types' {
  interface SessionEventMap {
    /** Research attempt charged before dispatch; failures and cancellations retain the charge. */
    'research/charge': { owner: SessionId; kind: 'search' | 'fetch' | 'browser'; queries: number }
  }
}

/**
 * Enforce limits through the shared executor, including Code Mode dispatches.
 * @param ctx - policy owner; registrations unwind on disposal.
 * @param config - optional positive integer limits; omissions impose no bound.
 */
export function apply(ctx: Context, config: Config): void {
  for (const value of Object.values(config)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
      throw new Error('research-policy limits must be positive integers within the Node timer range')
    }
  }
  ctx.on('tools/execute', async (exec, next) => {
    const kind = exec.name === 'web_search' ? 'search' : exec.name === 'web_fetch' ? 'fetch'
      : exec.name.startsWith('browser_') ? 'browser' : undefined
    if (kind === undefined || exec.agent === undefined) return next()
    const root = delegationRoot(ctx, exec.agent)
    const charges = root.events.filter(event => event.type === 'research/charge')
    const args = exec.arguments as { queries?: unknown }
    const queries = kind === 'search' && Array.isArray(args.queries) ? new Set(args.queries).size : 0
    const count = charges.filter(event => event.data.kind === kind).length
    const cap = kind === 'search' ? config.maxSearchCalls : kind === 'fetch' ? config.maxFetches : config.maxBrowserCalls
    const usedQueries = charges.reduce((total, event) => total + event.data.queries, 0)
    const remaining = config.maxDurationMs === undefined ? undefined
      : config.maxDurationMs - (Date.now() - (charges[0]?.time ?? Date.now()))
    if ((cap !== undefined && count >= cap)
      || (config.maxQueries !== undefined && usedQueries + queries > config.maxQueries)
      || (remaining !== undefined && remaining <= 0)) {
      throw new HarnessError('Research budget exhausted for this task and its subagents. Use the evidence already collected.', 'RESEARCH_BUDGET_EXHAUSTED')
    }
    // Admission and append are synchronous, so concurrent siblings cannot overspend a shared cap.
    root.append('research/charge', { owner: exec.agent.id, kind, queries })
    if (remaining === undefined) return next()
    using d = deadline(exec.signal, remaining, 'RESEARCH_BUDGET_EXHAUSTED')
    const upstream = exec.signal
    exec.signal = d.signal
    try {
      const result = await next()
      d.signal.throwIfAborted()
      return result
    } catch (error) {
      if (timeoutOf(d.signal, 'RESEARCH_BUDGET_EXHAUSTED') !== undefined) {
        throw new HarnessError('Research time budget exhausted.', 'RESEARCH_BUDGET_EXHAUSTED')
      }
      throw error
    } finally { exec.signal = upstream }
  })
}
