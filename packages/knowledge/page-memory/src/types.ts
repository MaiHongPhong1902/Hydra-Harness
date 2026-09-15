/** Durable observations for replay; recorded outcomes never authorize Browser actions. */
import type { StoredWorkflow } from './store.ts'

/** Outcome recorded for one durable page-memory observation. */
export type MemoryTraceOutcome = 'verified' | 'stale' | 'unavailable'



/** One append-only workflow observation used by offline replay. */
export interface WorkflowTrace {
  /** Monotonic database identifier. */
  readonly id: number
  /** Exact page key, including namespace and URL components. */
  readonly pageKey: string
  /** Stable workflow task name. */
  readonly task: string
  /** Workflow state observed at this point in the trace. */
  readonly workflow: StoredWorkflow
  /** Result of the live verification that produced this trace entry. */
  readonly outcome: MemoryTraceOutcome
  /** Save validates a postcondition; recall validates only page anchors. */
  readonly source: 'save' | 'recall'
  /** Elapsed verification time, excluding SQLite persistence; null when unmeasured. */
  readonly durationMs: number | null
  /** Canonical UTC time at which the observation was recorded. */
  readonly recordedAt: string
}
