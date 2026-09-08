/** Review wire request and response validation. @module */
import { z } from 'zod'
import { reviewChangeSchema } from '@hydra/harness-fs-review/client'
import type { Wire } from './rpc.schema.ts'
import type { RequestPayload } from './rpc-map.ts'

/** History request scoped to one session. */
export const reviewListRequestSchema = z.object({ sessionId: z.string().min(1), includeChildren: z.boolean().optional() }).strict() as unknown as z.ZodType<Wire<RequestPayload<'review.list'>>>
/** Exact ownership request for either review action. */
export const reviewActionRequestSchema = z.object({ sessionId: z.string().min(1), changeId: z.uuid() }).strict() as unknown as z.ZodType<Wire<RequestPayload<'review.undo'>>>
/** Persisted history response. */
export const reviewListValueSchema = z.object({ changes: z.array(reviewChangeSchema) })
/** Committed action result or safe refusal. */
export const reviewActionValueSchema = z.object({
  status: z.enum(['kept', 'rolledBack', 'alreadyRolledBack', 'conflict', 'unavailable']), change: reviewChangeSchema,
})
