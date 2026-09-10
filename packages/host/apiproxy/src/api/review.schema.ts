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

const mode = z.enum(['uncommitted', 'unstaged', 'staged', 'committed', 'branch'])
/** Only the session id and comparison options cross the wire; cwd is host-owned. */
export const reviewWorkspaceRequestSchema = z.object({
  sessionId: z.string().min(1), mode,
  ref: z.string().min(1).max(1024).refine(value => !value.startsWith('-') && !/[\u0000-\u001f]/u.test(value)).optional(),
  fullContext: z.boolean().optional(),
}).strict() as unknown as z.ZodType<Wire<RequestPayload<'review.workspace'>>>
/** Bounded current-workspace comparison response. */
export const reviewWorkspaceValueSchema = z.object({
  workspace: z.string(), repository: z.string().nullable(), branch: z.string().nullable(),
  branches: z.array(z.string()), commits: z.array(z.object({ oid: z.string(), subject: z.string() })),
  mode, baseRef: z.string().nullable(), truncated: z.boolean(),
  files: z.array(z.object({
    path: z.string(), status: z.enum(['added', 'modified', 'deleted']),
    additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
    binary: z.boolean(), truncated: z.boolean(), patch: z.string().nullable(),
    hunks: z.array(z.object({ header: z.string(), lines: z.array(z.string()) })),
  })),
})
