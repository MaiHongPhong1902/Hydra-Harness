/** Wire schemas for the browser authorization API. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  AuthorizationAccountView,
  AuthorizationAttemptView,
  AuthorizationEntryView,
  AuthorizationPromptView,
  AuthorizationUsageView,
} from './authorization.ts'

const identifierSchema = z.string().min(1).max(256)

/** Opaque credential-record key accepted at the authorization boundary. */
export const authorizationKeySchema = z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/).max(513)

/** Opaque attempt/prompt/account id. UUIDs keep ids unguessable and bounded. */
export const authorizationIdSchema = z.uuid()

const methodSchema = z.object({
  id: identifierSchema,
  label: z.string().min(1).max(512),
})

const accountSchema = z.object({
  id: identifierSchema,
  label: z.string().min(1).max(512),
}) satisfies z.ZodType<Wire<AuthorizationAccountView>>

const usageWindowSchema = z.object({
  name: z.string().min(1).max(256),
  group: z.string().min(1).max(128).optional(),
  window: z.string().min(1).max(128).optional(),
  description: z.string().min(1).max(1024).optional(),
  windowMinutes: z.number().int().positive().optional(),
  usedPercent: z.number().min(0).max(100),
  remainingAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  disabled: z.boolean().optional(),
  resetsAt: z.number().int().min(0).max(8_640_000_000_000).optional(),
})
const usageCreditsSchema = z.object({
  tier: z.enum(['current', 'paid', 'g1']),
  creditType: z.string().min(1).max(128).optional(),
  creditAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  minimumCreditAmountForUsage: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
})
const usageSchema = z.object({
  planType: z.string().max(128).optional(),
  limits: z.array(usageWindowSchema).max(256),
  bankedResetCount: z.number().int().min(0).optional(),
  credits: z.array(usageCreditsSchema).max(3).optional(),
  fetchedAt: z.number().nonnegative(),
}) satisfies z.ZodType<Wire<AuthorizationUsageView>>

const noticeSchema = z.object({
  message: z.string().min(1).max(4096),
  url: z.url().optional(),
  code: z.string().max(1024).optional(),
  snippet: z.string().max(8192).optional(),
})

const promptOptionSchema = z.object({
  id: identifierSchema,
  label: z.string().min(1).max(512),
  description: z.string().max(2048).optional(),
})

const promptSchema = z.object({
  id: authorizationIdSchema,
  kind: z.enum(['text', 'secret', 'select']),
  message: z.string().min(1).max(4096),
  placeholder: z.string().max(1024).optional(),
  options: z.array(promptOptionSchema).max(128).optional(),
}) satisfies z.ZodType<Wire<AuthorizationPromptView>>

const entrySchema = z.object({
  key: authorizationKeySchema,
  label: z.string().min(1).max(512),
  methods: z.array(methodSchema).min(1).max(32),
  inFlight: z.boolean(),
  accounts: z.array(accountSchema).max(256),
}) satisfies z.ZodType<Wire<AuthorizationEntryView>>

const attemptSchema = z.object({
  id: authorizationIdSchema,
  status: z.enum(['running', 'authorized', 'cancelled', 'failed']),
  notice: noticeSchema.optional(),
  prompt: promptSchema.optional(),
  error: z.string().max(1024).optional(),
}) satisfies z.ZodType<Wire<AuthorizationAttemptView>>

/** authorization.list request payload. */
export const authorizationListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'authorization.list'>>>

/** authorization.list response value. */
export const authorizationListValueSchema = z.object({
  entries: z.array(entrySchema).max(256),
}) satisfies z.ZodType<Wire<ResponseValue<'authorization.list'>>>

/** authorization.begin request payload. */
export const authorizationBeginRequestSchema = z.object({
  key: authorizationKeySchema,
  method: identifierSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.begin'>>>

/** authorization.begin response value. */
export const authorizationBeginValueSchema = z.object({
  attemptId: authorizationIdSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'authorization.begin'>>>

/** authorization.state request payload. */
export const authorizationStateRequestSchema = z.object({
  attemptId: authorizationIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.state'>>>

/** authorization.state response value. */
export const authorizationStateValueSchema = z.object({
  attempt: attemptSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'authorization.state'>>>

/** authorization.answer request payload. */
export const authorizationAnswerRequestSchema = z.object({
  attemptId: authorizationIdSchema,
  promptId: authorizationIdSchema,
  value: z.string().max(65536),
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.answer'>>>

/** authorization.answer response value. */
export const authorizationAnswerValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'authorization.answer'>>>

/** authorization.cancel request payload. */
export const authorizationCancelRequestSchema = z.object({
  attemptId: authorizationIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.cancel'>>>

/** authorization.cancel response value. */
export const authorizationCancelValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'authorization.cancel'>>>

/** authorization.logout request payload. */
export const authorizationLogoutRequestSchema = z.object({
  key: authorizationKeySchema,
  accountId: identifierSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.logout'>>>

/** authorization.logout response value. */
export const authorizationLogoutValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'authorization.logout'>>>

/** authorization.usage request payload. */
export const authorizationUsageRequestSchema = z.object({
  key: authorizationKeySchema,
  accountId: identifierSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'authorization.usage'>>>

/** authorization.usage response value. */
export const authorizationUsageValueSchema = z.object({
  usage: usageSchema.optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'authorization.usage'>>>
