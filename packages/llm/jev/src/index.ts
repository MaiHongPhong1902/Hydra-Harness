/** Optional unary TypeSafe Jev decision capability. */

import type { Context } from '@hydra/cordis'
import z from '@hydra/schemastery'
import { credentialRef, type CredentialRef } from '@hydra/harness-credentials'
import { launchEnvironmentOf } from '@hydra/harness-launch-environment'
import { installSettingsSection, settingsNamespace } from '@hydra/harness-settings'

/** JSON accepted by the Jev API. */
export type JevEntry = string | number | boolean | null | JevEntry[] | { readonly [key: string]: JevEntry }

/** One Jev question definition. */
export type JevQuestion = {
  readonly instructions: JevEntry
} & (
  | { readonly type: 'noul'; readonly criteria?: { readonly true?: JevEntry; readonly false?: JevEntry } | null }
  | { readonly type: 'choice'; readonly criteria: Readonly<Record<string, JevEntry>> }
  | { readonly type: 'score'; readonly criteria: readonly [JevEntry, JevEntry, ...JevEntry[]] }
)

/** One unary Jev request. */
export interface JevSystemOneRequest {
  readonly state: JevEntry
  readonly questions: Readonly<Record<string, JevQuestion>>
  readonly model?: string
}

/** Provider answer fields are intentionally open per question type. */
export interface JevAnswer {
  readonly type: 'noul' | 'choice' | 'score'
  readonly [key: string]: JevEntry | undefined
}

/** Validated Jev response. */
export interface JevSystemOneResult {
  readonly model: string
  readonly answers: Readonly<Record<string, JevAnswer>>
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number }
}

/** Optional cancellation and timeout controls for one decision. */
export interface JevRequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Structured Jev failure with no credential material in its message. */
export class JevError extends Error {
  /** Stable provider-neutral error code. */
  readonly code: 'MISSING_CREDENTIAL' | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'CANCELLED' | 'TRANSPORT' | 'INVALID_RESPONSE' | 'INVALID_REQUEST'
  /** HTTP status when the provider answered with one. */
  readonly status?: number

  /** @param message - safe diagnostic text; never include a key or response body. */
  constructor(
    message: string,
    code: JevError['code'],
    options: { readonly cause?: unknown; readonly status?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JevError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
  }
}

/** Service exposed as `ctx.jev` while the plugin is mounted. */
export interface JevService {
  /**
   * Ask TypeSafe Jev named questions about one state; failures reject with JevError.
   * Consumers own logging model-visible inputs and results through their session events.
   * @param request - state, named questions, and optional model override.
   * @param options - cancellation and timeout for this call.
   * @returns validated answers and usage from the independent Jev request.
   */
  systemOne(request: JevSystemOneRequest, options?: JevRequestOptions): Promise<JevSystemOneResult>
}

declare module '@hydra/cordis' {
  interface Context { jev: JevService }
}

/** Plugin configuration. The credential is a reference, never a secret value. */
export interface Config {
  /** Credential reference resolved at request time. */
  apiKeyEnv?: string
  /** Jev model id. */
  model?: string
  /** API root, useful for tests or a compatible gateway. */
  baseURL?: string
  /** Per-attempt request timeout. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('JEV_API_KEY'),
  model: z.string().default('typesafe-ai/jev'),
  baseURL: z.string().default('https://www.jevai.org'),
  timeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(10_000),
})

export const name = 'jev'
export const inject: readonly string[] = []

const NS = settingsNamespace('jev')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEntry(value: unknown): value is JevEntry {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isEntry)
  return isRecord(value) && Object.values(value).every(isEntry)
}

function isQuestion(value: unknown): value is JevQuestion {
  if (!isRecord(value) || !isEntry(value.instructions)) return false
  if (value.type === 'noul') {
    if (value.criteria === undefined || value.criteria === null) return true
    return isRecord(value.criteria) && Object.entries(value.criteria).every(([key, entry]) =>
      (key === 'true' || key === 'false') && isEntry(entry))
  }
  if (value.type === 'choice') {
    return isRecord(value.criteria) && Object.values(value.criteria).every(isEntry)
  }
  return value.type === 'score' && Array.isArray(value.criteria)
    && value.criteria.length >= 2 && value.criteria.every(isEntry)
}

function safeConfig(raw: Config): Required<Config> {
  const apiKeyEnv = raw.apiKeyEnv ?? 'JEV_API_KEY'
  const model = raw.model ?? 'typesafe-ai/jev'
  const baseURL = raw.baseURL ?? 'https://www.jevai.org'
  const timeoutMs = raw.timeoutMs ?? 10_000
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) throw new Error('jev: apiKeyEnv must be a credential reference')
  if (model.trim() === '') throw new Error('jev: model must be non-empty')
  let url: URL
  try { url = new URL(baseURL) } catch (error) { throw new Error('jev: baseURL must be an absolute URL', { cause: error }) }
  if (url.protocol !== 'https:') throw new Error('jev: baseURL must use HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('jev: baseURL cannot contain credentials, query, or fragment')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('jev: timeoutMs must be a positive timer interval')
  return { apiKeyEnv, model, baseURL: baseURL.replace(/\/+$/u, ''), timeoutMs }
}

function resultOf(
  response: unknown,
  questions: JevSystemOneRequest['questions'],
  fallbackModel: string,
): JevSystemOneResult {
  if (!isRecord(response)) throw new JevError('jev: provider returned an invalid response', 'INVALID_RESPONSE')
  if ('code' in response && response.code !== 0) {
    throw new JevError('jev: provider returned an application error', 'TRANSPORT')
  }
  const value = 'code' in response ? isRecord(response.data) ? response.data : undefined : response
  if (value === undefined || !isRecord(value) || (value.model !== undefined && typeof value.model !== 'string') || !isRecord(value.answers)) {
    throw new JevError('jev: provider returned an invalid response', 'INVALID_RESPONSE')
  }
  const usage = value.usage
  if (usage !== undefined && (!isRecord(usage) || typeof usage.input_tokens !== 'number'
    || typeof usage.output_tokens !== 'number'
    || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0
    || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0)) {
    throw new JevError('jev: provider returned an invalid response', 'INVALID_RESPONSE')
  }
  const normalizedUsage = usage === undefined ? undefined : {
    input_tokens: usage.input_tokens as number,
    output_tokens: usage.output_tokens as number,
  }
  if (Object.keys(value.answers).length !== Object.keys(questions).length) {
    throw new JevError('jev: provider returned an unexpected answer set', 'INVALID_RESPONSE')
  }
  const answers: [string, JevAnswer][] = []
  const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
  for (const [key, question] of Object.entries(questions)) {
    const answer = value.answers[key]
    if (!isRecord(answer) || !isEntry(answer) || answer.type !== question.type
      || (question.type === 'noul' && !probability(answer.noul))
      || (question.type !== 'noul' && !probability(answer.confidence))
      || (question.type === 'choice' && (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)))
      || (question.type === 'score' && (typeof answer.score !== 'number' || !Number.isFinite(answer.score)
        || answer.score < 0 || answer.score > question.criteria.length - 1))) {
      throw new JevError('jev: provider returned an invalid answer', 'INVALID_RESPONSE')
    }
    answers.push([key, answer as JevAnswer])
  }
  return {
    model: typeof value.model === 'string' && value.model !== '' ? value.model : fallbackModel,
    answers: Object.fromEntries(answers),
    ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
  }
}

async function readApiKey(ctx: Context, ref: CredentialRef): Promise<string> {
  const fromCredentials = await ctx.get('credentials')?.resolve(ref)
  const value = fromCredentials?.value ?? launchEnvironmentOf(ctx).get(ref)?.value
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JevError(`jev: no API key configured for ${ref}`, 'MISSING_CREDENTIAL')
  }
  if (!/^[\x21-\x7E]+$/u.test(value.trim())) throw new JevError('jev: configured API key is invalid', 'MISSING_CREDENTIAL')
  return value.trim()
}

async function requestOne(
  ctx: Context,
  settings: () => Required<Config>,
  request: JevSystemOneRequest,
  options: JevRequestOptions | undefined,
  lifetime: AbortSignal,
): Promise<JevSystemOneResult> {
  const cancelled = (): boolean => lifetime.aborted || options?.signal?.aborted === true
  if (cancelled()) throw new JevError('jev: request cancelled', 'CANCELLED')
  const raw = request as unknown
  if (!isRecord(raw) || !isEntry(raw.state) || !isRecord(raw.questions)
    || Object.keys(raw.questions).length === 0 || !Object.values(raw.questions).every(isQuestion)
    || (raw.model !== undefined && (typeof raw.model !== 'string' || raw.model.trim() === ''))) {
    throw new JevError('jev: invalid request', 'INVALID_REQUEST')
  }
  const questions = raw.questions as JevSystemOneRequest['questions']
  const state = raw.state
  const model = raw.model
  const connection = settings()
  const key = await readApiKey(ctx, credentialRef(connection.apiKeyEnv))
  const timeout = options?.timeoutMs ?? connection.timeoutMs
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new JevError('jev: invalid timeout interval', 'TIMEOUT')
  const deadline = AbortSignal.timeout(timeout)
  const signal = AbortSignal.any([lifetime, deadline, ...options?.signal === undefined ? [] : [options.signal]])
  try {
    signal.throwIfAborted()
    const response = await fetch(`${connection.baseURL}/api/v1/decisions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, questions, model: model ?? connection.model }),
      signal,
      redirect: 'error',
    })
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'AUTH'
        : response.status === 429 ? 'RATE_LIMIT' : 'TRANSPORT'
      throw new JevError(`jev: provider returned HTTP ${response.status}`, code, { status: response.status })
    }
    let body: unknown
    try { body = await response.json() } catch { throw new JevError('jev: provider returned invalid JSON', 'INVALID_RESPONSE') }
    return resultOf(body, questions, model ?? connection.model)
  } catch (error) {
    if (cancelled()) throw new JevError('jev: request cancelled', 'CANCELLED')
    if (deadline.aborted) throw new JevError('jev: request timed out', 'TIMEOUT')
    if (error instanceof JevError) throw error
    throw new JevError('jev: provider request failed', 'TRANSPORT')
  }
}

/** Mount the optional decision capability; missing credentials fail per call, not at boot. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = safeConfig(config)
  let current = (): Required<Config> => resolved
  const lifetime = new AbortController()
  const pending = new Set<Promise<JevSystemOneResult>>()
  const service: JevService = { systemOne: (request, options) => {
    const run = requestOne(ctx, current, request, options, lifetime.signal)
    pending.add(run)
    void run.then(() => pending.delete(run), () => pending.delete(run))
    return run
  } }
  ctx.effect(() => ctx.reflect.provide('jev', service), 'jev: service')
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(pending)
  }, 'jev: pending requests')
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = () => safeConfig(source()) },
    onChange: () => {},
    validate: (value) => { safeConfig(value) },
  })
}
