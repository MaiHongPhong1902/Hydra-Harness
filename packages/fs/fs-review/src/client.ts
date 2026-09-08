/** Browser-safe validation for durable/wire review records. @module */
import { z } from 'zod'
import type { ReviewChange } from './types.ts'
import type { SessionId } from '@hydra/harness-session/types'
export type { ChangeId, ReviewChange, ReviewHunk, ReviewOutcome } from './types.ts'

declare module '@hydra/cordis' {
  interface Events {
    /**
     * A durable record was created or changed; clients refetch its history.
     * @param sessionId - session owning the committed record.
     * @mode emit
     */
    'file-review/changed'(sessionId: SessionId): void
  }
}

const hash = z.string().regex(/^[a-f0-9]{64}$/).nullable()
/** Reject unknown record versions, unsafe paths, and malformed snapshot evidence. */
export const reviewChangeSchema = z.object({
  version: z.literal(1), id: z.uuid(), sessionId: z.string().min(1),
  callId: z.string().min(1), rootCallId: z.string().min(1), toolName: z.string().min(1),
  seq: z.number().int().nonnegative(), turnSeq: z.number().int().nonnegative().nullable(),
  stepSeq: z.number().int().nonnegative().nullable(), parentSessionId: z.string().nullable(),
  agentPreset: z.string().nullable(), createdAt: z.number().int().nonnegative(),
  workspace: z.string().min(1),
  path: z.string().min(1).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.includes(':') && !p.split('/').includes('..')),
  operation: z.enum(['write', 'edit']), status: z.enum(['added', 'modified', 'deleted']),
  state: z.enum(['pending', 'active', 'kept', 'undoing', 'rolledBack']),
  beforeHash: hash, afterHash: hash, reversible: z.boolean(), binary: z.boolean(), truncated: z.boolean(),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  hunks: z.array(z.object({ header: z.string(), lines: z.array(z.string()) })),
}).strict() as unknown as z.ZodType<ReviewChange>
