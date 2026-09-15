/** Offline stopping-policy replay over observed Browser trajectories, without executing actions. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

/** One completed tool call; success describes the tool, never the whole task. */
export interface ReplayStep {
  readonly kind: string
  readonly outcome: 'success' | 'failure'
  readonly durationMs: number | null
  readonly verifiedPostcondition: boolean
}

/** An observed sequential attempt; no raw arguments, page content, or identities are retained. */
export interface ReplayRun {
  readonly id: number
  readonly taskDigest: string
  readonly steps: readonly ReplayStep[]
  /** Concurrent calls or incomplete logs cannot establish a replayable action order. */
  readonly supported: boolean
}

/** Prefix visible to a stopping policy, excluding future outcomes. */
export interface ReplayPrefix {
  readonly taskDigest: string
  readonly steps: readonly ReplayStep[]
}

/** Continue along the recorded chain or stop; policies cannot replace or reorder actions. */
export type ReplayPolicy = (prefix: ReplayPrefix) => 'continue' | 'stop'

/** Metrics on recorded runs; unknown runs do not count as failures. */
export interface ReplayMetrics {
  readonly verified: number
  readonly unknown: number
  readonly unsupported: number
  readonly stopped: number
  readonly calls: number
  readonly measuredMs: number
  readonly unmeasuredCalls: number
}

/** One policy's training and holdout metrics. */
export interface ReplayPolicyResult {
  readonly name: string
  readonly training: ReplayMetrics
  readonly holdout: ReplayMetrics
}

/** Comparison report; selection is advisory and runtime remains baseline. */
export interface ReplayComparisonReport {
  readonly selected: string
  readonly holdoutPreservesVerified: boolean
  readonly runtimePolicy: 'baseline'
  readonly results: readonly ReplayPolicyResult[]
}

const Text = z.object({ type: z.literal('text'), text: z.string() })
const Call = z.object({ callId: z.string(), name: z.string(), arguments: z.string() })
const NestedCall = z.object({ subCallId: z.string(), name: z.string(), arguments: z.unknown() })
const Result = z.object({ toolCallId: z.string(), isError: z.boolean(), content: z.array(z.unknown()) })
const Envelope = z.object({ type: z.string(), time: z.number().nonnegative().optional(), data: z.unknown().optional() })

/** Extract bounded, sanitized attempts from one native or Code Mode session log.
 * @param records - Decoded JSONL records, including an optional session header.
 * @param maxSteps - Maximum steps per attempt; longer or overlapping attempts are unsupported.
 * @returns Attempts split by task selection, verified save, and turn lifecycle.
 */
export function extractReplayRuns(records: readonly unknown[], maxSteps: number): ReplayRun[] {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('page-memory replay: maxSteps must be positive')
  const runs: ReplayRun[] = []
  let current: { id: number; taskDigest: string; steps: ReplayStep[]; supported: boolean } | undefined
  let taskDigest: string | undefined
  const pending = new Map<string, { name: string; time?: number; args: unknown; run: typeof current }>()
  function finish(): void {
    if (current !== undefined && (current.steps.length > 0 || !current.supported)) runs.push(current)
    current = undefined
  }
  function start(id: string, name: string, args: unknown, time?: number): void {
    if (!name.startsWith('browser_') && !name.startsWith('page_memory_')) return
    if (pending.has(id)) throw new Error('page-memory replay: duplicate pending call id')
    if (current === undefined && taskDigest !== undefined) {
      current = { id: runs.length + 1, taskDigest, steps: [], supported: true }
    }
    if (pending.size > 0) {
      if (current !== undefined) current.supported = false
      for (const call of pending.values()) if (call.run !== undefined) call.run.supported = false
    }
    pending.set(id, { name, args, ...(time === undefined ? {} : { time }), run: current })
  }
  function result(id: string, isError: boolean, content: unknown[], time?: number): void {
    const call = pending.get(id)
    if (call === undefined) throw new Error('page-memory replay: result has no matching call')
    pending.delete(id)
    if (call.name === 'page_memory_get' && !isError) {
      const args = z.object({ task: z.string().min(1).max(128).optional() }).parse(call.args)
      if (args.task !== undefined) {
        const selected = createHash('sha256').update(args.task).digest('hex')
        if (selected !== taskDigest) { finish(); taskDigest = selected }
      }
    }
    if (!call.name.startsWith('browser_') && call.name !== 'page_memory_upsert') return
    const run = call.run
    if (run === undefined) return
    const verifiedPostcondition = call.name === 'page_memory_upsert' && !isError
      && content.some((block) => { const parsed = Text.safeParse(block); return parsed.success && parsed.data.text.startsWith('Page memory verified: ') })
    if (run.steps.length >= maxSteps) run.supported = false
    else {
      const durationMs = call.time === undefined || time === undefined ? null : time - call.time
      if (durationMs !== null && durationMs < 0) run.supported = false
      run.steps.push({ kind: call.name, outcome: isError ? 'failure' : 'success', durationMs, verifiedPostcondition })
    }
    if (verifiedPostcondition && run === current) finish()
  }
  for (const record of records) {
    const event = Envelope.parse(record)
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      for (const call of pending.values()) if (call.run !== undefined) call.run.supported = false
      pending.clear()
      finish()
      taskDigest = undefined
    } else if (event.type === 'tool/call') {
      const call = Call.parse(event.data)
      // Browser arguments are deliberately not parsed or copied into the retained trajectory.
      const args: unknown = call.name.startsWith('page_memory_') ? JSON.parse(call.arguments) as unknown : undefined
      start(call.callId, call.name, args, event.time)
    } else if (event.type === 'tool/result') {
      const data = z.object({ message: z.object({ content: z.array(z.unknown()) }) }).parse(event.data)
      for (const block of data.message.content) {
        const parsed = Result.safeParse(block)
        if (parsed.success && pending.has(parsed.data.toolCallId)) {
          result(parsed.data.toolCallId, parsed.data.isError, parsed.data.content, event.time)
        }
      }
    } else if (event.type === 'tool/code-dispatch-start') {
      const call = NestedCall.parse(event.data)
      start(call.subCallId, call.name, call.name.startsWith('page_memory_') ? call.arguments : undefined, event.time)
    } else if (event.type === 'tool/code-dispatch') {
      const call = NestedCall.extend({ isError: z.boolean(), content: z.array(z.unknown()) }).parse(event.data)
      if (pending.has(call.subCallId)) result(call.subCallId, call.isError, call.content, event.time)
    }
  }
  for (const call of pending.values()) if (call.run !== undefined) call.run.supported = false
  finish()
  return runs
}

/** Replay one policy without exposing future steps, issuing Browser calls, or inventing outcomes.
 * @param runs - Observed attempts in chronological order.
 * @param policy - A decision function receiving only the revealed prefix.
 * @returns Costs and verified postconditions reached on retained history.
 */
export function replayRuns(runs: readonly ReplayRun[], policy: ReplayPolicy): ReplayMetrics {
  let verified = 0, unknown = 0, unsupported = 0, stopped = 0, calls = 0, measuredMs = 0, unmeasuredCalls = 0
  for (const run of runs) {
    if (!run.supported) { unsupported++; continue }
    const steps: ReplayStep[] = []
    let reached = false
    for (const step of run.steps) {
      if (policy(Object.freeze({ taskDigest: run.taskDigest, steps: Object.freeze([...steps]) })) === 'stop') { stopped++; break }
      const revealed = Object.freeze({ ...step })
      steps.push(revealed)
      calls++
      if (step.durationMs === null) unmeasuredCalls++
      else measuredMs += step.durationMs
      if (step.verifiedPostcondition) { reached = true; break }
    }
    if (reached) verified++
    else unknown++
  }
  return { verified, unknown, unsupported, stopped, calls, measuredMs, unmeasuredCalls }
}

/** Compare prefix policies with the recorded baseline and an untouched chronological holdout.
 * @param runs - Observed attempts in chronological order.
 * @param candidates - Named stopping policies; baseline is always included and wins ties.
 * @param holdoutRuns - Number of final attempts reserved from policy selection.
 * @returns Training and holdout evidence; this report never changes runtime policy.
 */
export function compareReplayPolicies(
  runs: readonly ReplayRun[], candidates: Readonly<Record<string, ReplayPolicy>>, holdoutRuns: number,
): ReplayComparisonReport {
  if (!Number.isSafeInteger(holdoutRuns) || holdoutRuns < 1 || holdoutRuns >= runs.length) throw new Error('page-memory replay: holdout must leave at least one training run')
  if ('baseline' in candidates) throw new Error('page-memory replay: baseline is reserved')
  const training = runs.slice(0, -holdoutRuns)
  const holdout = runs.slice(-holdoutRuns)
  const policies: Record<string, ReplayPolicy> = { baseline: () => 'continue', ...candidates }
  const results = Object.entries(policies).map(([name, policy]) => ({
    name, training: replayRuns(training, policy), holdout: replayRuns(holdout, policy),
  }))
  const ordered = [...results].sort((a, b) => b.training.verified - a.training.verified || a.training.calls - b.training.calls)
  const selected = ordered[0]
  const baseline = results.find(result => result.name === 'baseline')
  if (selected === undefined || baseline === undefined) throw new Error('page-memory replay: no policy results')
  return {
    selected: selected.name,
    holdoutPreservesVerified: selected.holdout.verified === baseline.holdout.verified,
    runtimePolicy: 'baseline' as const,
    results,
  }
}
