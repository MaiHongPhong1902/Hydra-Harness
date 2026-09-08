/** Durable agent-owned change evidence, independent of current Git state. @module */
import type { Branded } from '@hydra/harness-brand'
import type { SessionId } from '@hydra/harness-session/types'
import type { CallId } from '@hydra/harness-llm/brand'

/** Identifies one snapshot and its review record. */
export type ChangeId = Branded<'ChangeId'>

/** One stored unified-diff hunk. */
export interface ReviewHunk {
  header: string
  lines: string[]
}

/** Snapshot metadata and review evidence committed together. */
export interface ReviewChange {
  version: 1
  id: ChangeId
  sessionId: SessionId
  callId: CallId
  rootCallId: CallId
  toolName: string
  /** Session sequence immediately before the mutation; turn/step use their opening seq. */
  seq: number
  turnSeq: number | null
  stepSeq: number | null
  parentSessionId: SessionId | null
  agentPreset: string | null
  createdAt: number
  /** Canonical workspace root and relative file path, validated again before Undo. */
  workspace: string
  path: string
  operation: 'write' | 'edit'
  status: 'added' | 'modified' | 'deleted'
  /** Pending/undoing records are uncertain after interruption and cannot mutate files. */
  state: 'pending' | 'active' | 'kept' | 'undoing' | 'rolledBack'
  beforeHash: string | null
  afterHash: string | null
  reversible: boolean
  binary: boolean
  truncated: boolean
  additions: number
  deletions: number
  hunks: ReviewHunk[]
}

/** User review action outcome. Conflicts never modify workspace files. */
export interface ReviewOutcome {
  status: 'kept' | 'rolledBack' | 'alreadyRolledBack' | 'conflict' | 'unavailable'
  change: ReviewChange
}
