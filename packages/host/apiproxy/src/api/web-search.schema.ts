/** Wire validation for search provider discovery and connection probes. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** Provider directory query. */
export const webSearchProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'webSearch.providers'>>>
/** Provider-owned fields and truthful endpoint capabilities. */
export const webSearchProvidersValueSchema = z.object({ providers: z.array(z.object({
  id: z.string(), displayName: z.string(), description: z.string().optional(),
  configurable: z.boolean(), settingsNs: z.string(), credentialRef: z.string(),
  capabilities: z.object({ web: z.boolean(), images: z.boolean(), news: z.boolean(), videos: z.boolean(), academic: z.boolean() }),
  fields: z.array(z.object({ key: z.string(), label: z.string(), kind: z.enum(['text', 'number', 'select', 'json']),
    options: z.array(z.string()).optional(), advanced: z.boolean().optional(), hint: z.string().optional() })),
})) }) satisfies z.ZodType<Wire<ResponseValue<'webSearch.providers'>>>
/** A probe accepts only a provider id, never secrets or draft configuration. */
export const webSearchTestConnectionRequestSchema = z.object({ provider: z.string().min(1) }).strict() satisfies z.ZodType<Wire<RequestPayload<'webSearch.testConnection'>>>
/** Successful probes expose only a result count; failures use owned diagnostics. */
export const webSearchTestConnectionValueSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(true), provider: z.string(), resultCount: z.number().int().nonnegative() }),
  z.object({ connected: z.literal(false), provider: z.string(), code: z.enum(['AUTH_ERROR', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'CONFIG_ERROR', 'UNKNOWN']), message: z.string(), retryable: z.boolean() }),
]) satisfies z.ZodType<Wire<ResponseValue<'webSearch.testConnection'>>>
