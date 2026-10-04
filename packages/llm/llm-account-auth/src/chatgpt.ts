/** ChatGPT OAuth provider construction and authorization flow. */

import {
  type AuthInteraction,
  type Model,
  type Provider,
} from '@earendil-works/pi-ai'
import type { Context } from '@hydraharness/cordis'
import type {
  AuthorizationMethod,
  AuthorizationSession,
} from '@hydraharness/harness-authorization'
import { accountRecordKey, type AccountPool } from './accounts.ts'
import type { AccountModelProfile, AccountProviderProfile } from './config.ts'
import { accountInteraction } from './interaction.ts'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '@hydraharness/harness-llm-pi-ai'
import { attributionHeaders, inferModelEndpoints, LlmError, resolveRetryPolicy, type LlmDiscoveredModel, type MediaGenerationOptions } from '@hydraharness/harness-llm'
import type { ResolvedPiAiProviderProfile } from '@hydraharness/harness-llm-pi-ai'

/** One model row returned by ChatGPT's account-scoped model endpoint. */
interface ChatGptModelRow {
  id?: unknown
  slug?: unknown
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  supported_in_api?: unknown
  visibility?: unknown
}

/**
 * Client version the model listing is asked for. The endpoint requires the
 * field — it answers a missing one with HTTP 400 rather than a default — and
 * serves the catalog that version was released against: an older one is
 * answered with an empty list instead of an error, so this value names the
 * catalog era the harness reads, not the identity of the caller.
 */
export const CHATGPT_MODELS_CLIENT_VERSION = '1.0.0'

/** Image models served by Codex's image endpoint, absent from its conversation catalog. Account entitlement is checked on generation. */
export const CHATGPT_IMAGE_MODELS = [
  { id: 'gpt-image-1.5', name: 'GPT Image 1.5', endpoints: ['images/generations'] },
  { id: 'gpt-image-2', name: 'GPT Image 2', endpoints: ['images/generations'] },
] as const

/**
 * Fetch the models enabled for one ChatGPT account.
 * @param request - account token, account id, endpoint, and optional cancellation.
 * @returns live conversation models followed by the adapter's supported image models; listing does not establish image entitlement.
 */
export async function discoverChatGptModels(request: {
  accessToken: string
  accountId: string
  baseURL?: string
  signal?: AbortSignal
}): Promise<LlmDiscoveredModel[]> {
  const baseURL = request.baseURL ?? 'https://chatgpt.com/backend-api'
  let response: Response
  try {
    response = await fetch(
      `${baseURL.replace(/\/+$/u, '')}/codex/models?client_version=${CHATGPT_MODELS_CLIENT_VERSION}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${request.accessToken}`,
          'chatgpt-account-id': request.accountId,
          originator: 'pi',
          ...attributionHeaders(),
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    )
  } catch (error: unknown) {
    if (request.signal?.aborted) throw new LlmError('ChatGPT model discovery was aborted', 'ABORTED', { cause: error })
    throw new LlmError('ChatGPT model discovery request failed', 'TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel()
    const code = response.status === 401 || response.status === 403 ? 'AUTH'
      : response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
    throw new LlmError(`ChatGPT model discovery failed with HTTP ${String(response.status)}`, code, {
      status: response.status,
    })
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error: unknown) {
    throw new LlmError('ChatGPT model discovery returned malformed JSON', 'MALFORMED_RESPONSE', { cause: error })
  }
  const object = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as { data?: unknown; models?: unknown }
    : undefined
  const rows = Array.isArray(object?.data) ? object.data : object?.models
  if (!Array.isArray(rows)) throw new LlmError('ChatGPT model discovery returned no model list', 'MALFORMED_RESPONSE')
  const seen = new Set<string>()
  const discovered = rows.flatMap((raw): LlmDiscoveredModel[] => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
    const row = raw as ChatGptModelRow
    if (row.supported_in_api === false || row.visibility === 'hidden' || row.visibility === 'hide') return []
    const id = [row.id, row.slug].find(value => typeof value === 'string' && value.length > 0) as string | undefined
    if (id === undefined || seen.has(id)) return []
    seen.add(id)
    const name = [row.name, row.display_name].find(value => typeof value === 'string' && value.length > 0) as string | undefined
    const capacity = (...values: unknown[]): number | undefined => values.find(value =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0) as number | undefined
    const contextWindow = capacity(row.context_window, row.context_length)
    const maxTokens = capacity(row.max_output_tokens, row.max_tokens)
    return [{
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }]
  })
  for (const model of CHATGPT_IMAGE_MODELS) {
    const existing = discovered.find(candidate => candidate.id === model.id)
    if (existing === undefined) discovered.push({ ...model, endpoints: [...model.endpoints] })
    else existing.endpoints = [...model.endpoints]
  }
  return discovered
}

/** Provider route owned by the ChatGPT account flow. */
export const CHATGPT_PROVIDER = 'chatgpt'
/** User-facing provider label. */
export const CHATGPT_LABEL = 'ChatGPT'

const CHATGPT_METHOD: AuthorizationMethod = {
  id: 'oauth',
  label: 'Sign in with ChatGPT',
}

type ChatGptProvider = Provider<'openai-codex-responses'>

let providerPromise: Promise<ChatGptProvider> | undefined

/** Load the pi-ai ChatGPT provider only when this route is used. */
async function loadProvider(): Promise<ChatGptProvider> {
  providerPromise ??= Promise.all([
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-ai/providers/openai-codex'),
  ]).then(([, providerModule]) => providerModule.openaiCodexProvider())
  return providerPromise
}

function cloneModel(
  model: Model<'openai-codex-responses'>,
  id: string,
  name: string | undefined,
  contextWindow: number | undefined,
  maxTokens: number | undefined,
): Model<'openai-codex-responses'> {
  return {
    ...model,
    id,
    name: name ?? model.name,
    provider: CHATGPT_PROVIDER,
    input: [...model.input],
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
  }
}

function fallbackModel(
  id: string,
  name: string | undefined,
  contextWindow: number,
  maxTokens: number,
): Model<'openai-codex-responses'> {
  return {
    id,
    name: name ?? id,
    api: 'openai-codex-responses',
    provider: CHATGPT_PROVIDER,
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }
}

function routeProvider(
  base: ChatGptProvider,
  models: readonly Model<'openai-codex-responses'>[],
): Provider<'openai-codex-responses'> {
  const toBaseModel = (model: Model<'openai-codex-responses'>): Model<'openai-codex-responses'> => ({
    ...model,
    provider: base.id,
    api: 'openai-codex-responses',
  })
  return {
    id: CHATGPT_PROVIDER,
    name: CHATGPT_LABEL,
    ...(base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl }),
    ...(base.headers === undefined ? {} : { headers: { ...base.headers } }),
    auth: base.auth,
    getModels: () => models,
    stream: (model, context, options) => base.stream(toBaseModel(model), context, options),
    streamSimple: (model, context, options) => base.streamSimple(toBaseModel(model), context, options),
  }
}

/**
 * Build a validated pi-ai profile for one ChatGPT account route.
 * @param source - current account-route settings.
 * @returns the resolved profile used by the pi-ai adapter.
 */
export async function buildChatGptProfile(
  source: AccountProviderProfile,
): Promise<ResolvedPiAiProviderProfile> {
  const base = await loadProvider()
  const catalog = base.getModels()
  const byId = new Map(catalog.map(model => [model.id, model]))
  const entries: readonly AccountModelProfile[] = source.models ?? [...catalog.map(model => ({ id: model.id })),
    ...CHATGPT_IMAGE_MODELS.map(model => ({ ...model, endpoints: [...model.endpoints] }))]
  const models = entries.map((entry) => {
    const template = byId.get(entry.id) ?? catalog[0]
    return template === undefined
      ? fallbackModel(
        entry.id,
        entry.name,
        entry.contextWindow ?? source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        entry.maxTokens ?? source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      )
      : cloneModel(template, entry.id, entry.name ?? (byId.has(entry.id) ? undefined : entry.id), entry.contextWindow, entry.maxTokens)
  })
  const configuredMaxTokens = new Map(
    entries.flatMap(entry => entry.maxTokens === undefined ? [] : [[entry.id, entry.maxTokens] as const]),
  )
  const baseURL = source.endpoint ?? base.baseUrl
  const piProvider = routeProvider(base, models.map(model => ({ ...model, ...baseURL === undefined ? {} : { baseUrl: baseURL } })))
  return {
    provider: CHATGPT_PROVIDER,
    displayName: CHATGPT_LABEL,
    api: 'openai-codex-responses',
    apiKeyFallbackEnvs: [],
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(source.reasoning === undefined ? {} : { reasoning: source.reasoning }),
    ...(source.thinkingBudgets === undefined ? {} : { thinkingBudgets: source.thinkingBudgets }),
    ...(source.cacheRetention === undefined ? {} : { cacheRetention: source.cacheRetention }),
    ...(source.transport === undefined ? {} : { transport: source.transport }),
    ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
    ...(source.websocketConnectTimeoutMs === undefined
      ? {}
      : { websocketConnectTimeoutMs: source.websocketConnectTimeoutMs }),
    streamIdleTimeoutMs: source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    retryPolicy: resolveRetryPolicy(source.retryPolicy, 'llm-account-auth: chatgpt retryPolicy'),
    configuredMaxTokens,
    modelEndpoints: new Map(entries.flatMap((entry) => {
      const endpoints = entry.endpoints ?? inferModelEndpoints(entry.id)
      return endpoints === undefined ? [] : [[entry.id, [...endpoints]] as const]
    })),
    piProvider,
  }
}

/**
 * Refresh the selected ChatGPT account before reading its account-scoped credential.
 * @param pool - selected Host account pool.
 * @param profile - resolved ChatGPT provider implementation.
 * @param signal - caller cancellation, including OAuth refresh.
 * @returns the usable access token and provider-issued account id.
 */
export async function chatGptCredential(
  pool: AccountPool, profile: ResolvedPiAiProviderProfile, signal?: AbortSignal,
): Promise<{ access: string; accountId: string }> {
  signal?.throwIfAborted()
  await pool.credentials.modify('chatgpt', async (current) => {
    signal?.throwIfAborted()
    if (current?.type !== 'oauth') throw new LlmError('ChatGPT account has invalid credentials.', 'INVALID_CREDENTIAL')
    if (Date.now() < current.expires) return undefined
    const oauth = profile.piProvider.auth.oauth
    if (oauth === undefined) throw new LlmError('ChatGPT account route requires OAuth.', 'INVALID_CREDENTIAL')
    return oauth.refresh(current, signal)
  })
  signal?.throwIfAborted()
  const stored = await pool.credentials.read('chatgpt')
  if (stored?.type !== 'oauth' || typeof stored.access !== 'string' || stored.access.length === 0) throw new LlmError('ChatGPT account has invalid credentials.', 'INVALID_CREDENTIAL')
  const accountId = (stored as { accountId?: unknown }).accountId
  if (typeof accountId !== 'string' || accountId.length === 0) throw new LlmError('ChatGPT account has no account id.', 'INVALID_CREDENTIAL')
  return { access: stored.access, accountId }
}

/**
 * Send one image request through the selected account's native Codex image endpoint.
 * @param options - image model, controls, and consumer cancellation.
 * @param pool - selected account and locked OAuth refresh store.
 * @param profile - native endpoint and admitted model endpoints.
 * @returns the original Images API response, including provider rejections.
 */
export async function requestChatGptImage(
  options: MediaGenerationOptions & { model: string }, pool: AccountPool, profile: ResolvedPiAiProviderProfile,
): Promise<Response> {
  if (options.endpoint !== 'images/generations' || !profile.modelEndpoints.get(options.model)?.includes(options.endpoint)) throw new LlmError('ChatGPT account route supports declared image models only; video is unavailable.', 'UNSUPPORTED_GENERATION')
  const credential = await chatGptCredential(pool, profile, options.signal)
  const baseURL = profile.baseURL ?? 'https://chatgpt.com/backend-api'
  return fetch(`${baseURL.replace(/\/+$/u, '')}/codex/images/generations`, {
    method: 'POST', redirect: 'error', signal: options.signal,
    headers: { ...attributionHeaders(), 'Content-Type': 'application/json', accept: 'application/json',
      authorization: `Bearer ${credential.access}`, 'chatgpt-account-id': credential.accountId, originator: 'pi' },
    body: JSON.stringify({ ...options.body, model: options.model }),
  })
}

/**
 * Register the ChatGPT OAuth flow without loading pi-ai until a login starts.
 * @param ctx - context whose authorization service owns the flow.
 * @param pool - durable account pool receiving the completed credential.
 */
export function registerChatGptFlow(ctx: Context, pool: AccountPool): void {
  ctx.authorization.registerFlow({
    key: accountRecordKey(CHATGPT_PROVIDER),
    label: CHATGPT_LABEL,
    methods: [CHATGPT_METHOD],
    accounts: pool.accounts,
    run: async (session) => { await loginChatGpt(session, pool) },
  })
}

/**
 * Run one ChatGPT OAuth login and commit its credential after it completes.
 * @param session - authorization session carrying prompts, notices, and cancellation.
 * @param pool - durable account pool receiving the completed credential.
 * @returns a promise that settles after the credential is durably stored.
 */
export async function loginChatGpt(session: AuthorizationSession, pool: AccountPool): Promise<void> {
  const provider = await loadProvider()
  const oauth = provider.auth.oauth
  if (oauth === undefined) throw new Error('ChatGPT provider does not offer OAuth login')
  const interaction: AuthInteraction = accountInteraction(session)
  const credential = await oauth.login(interaction)
  await pool.add(undefined, credential, session.signal)
}
