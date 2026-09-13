/** ChatGPT OAuth provider construction and authorization flow. */

import type {
  AuthInteraction,
  AuthEvent,
  AuthPrompt,
  Model,
  Provider,
} from '@earendil-works/pi-ai'
import type { Context } from '@hydra/cordis'
import type {
  AuthorizationMethod,
  AuthorizationPrompt,
  AuthorizationSession,
} from '@hydra/harness-authorization'
import { accountRecordKey, type AccountPool } from './accounts.ts'
import type { AccountProviderProfile } from './config.ts'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '@hydra/harness-llm-pi-ai'
import { resolveRetryPolicy } from '@hydra/harness-llm'
import type { ResolvedPiAiProviderProfile } from '@hydra/harness-llm-pi-ai'

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
  const entries = source.models
  const models = entries === undefined
    ? catalog.map(model => cloneModel(model, model.id, undefined, undefined, undefined))
    : entries.map((entry) => {
      const template = byId.get(entry.id) ?? catalog[0]
      return template === undefined
        ? fallbackModel(
          entry.id,
          entry.name,
          entry.contextWindow ?? source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
          entry.maxTokens ?? source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
        )
        : cloneModel(template, entry.id, entry.name, entry.contextWindow, entry.maxTokens)
    })
  const configuredMaxTokens = new Map(
    (entries ?? []).flatMap(entry => entry.maxTokens === undefined ? [] : [[entry.id, entry.maxTokens] as const]),
  )
  const piProvider = routeProvider(base, models)
  return {
    provider: CHATGPT_PROVIDER,
    displayName: CHATGPT_LABEL,
    api: 'openai-codex-responses',
    apiKeyFallbackEnvs: [],
    ...(base.baseUrl === undefined ? {} : { baseURL: base.baseUrl }),
    streamIdleTimeoutMs: source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'llm-account-auth: chatgpt retryPolicy'),
    configuredMaxTokens,
    piProvider,
  }
}

function relay(event: AuthEvent, session: AuthorizationSession): void {
  switch (event.type) {
    case 'info': {
      const link = event.links?.[0]
      session.notify({ message: event.message, ...(link === undefined ? {} : { url: link.url }) })
      return
    }
    case 'auth_url':
      session.notify({
        message: event.instructions ?? 'Open this page to continue signing in.',
        url: event.url,
      })
      return
    case 'device_code':
      session.notify({
        message: 'Enter this code on the verification page to finish signing in.',
        url: event.verificationUri,
        code: event.userCode,
      })
      return
    case 'progress':
      session.notify({ message: event.message })
      return
    default:
      session.notify({ message: 'Signing in…' })
  }
}

function restate(prompt: AuthPrompt): AuthorizationPrompt {
  const signal = prompt.signal === undefined ? {} : { signal: prompt.signal }
  switch (prompt.type) {
    case 'select':
      return { ...signal, kind: 'select', message: prompt.message, options: prompt.options }
    case 'secret':
    case 'manual_code':
      return {
        ...signal,
        kind: 'secret',
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      }
    default:
      return {
        ...signal,
        kind: 'text',
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      }
  }
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
  const interaction: AuthInteraction = {
    signal: session.signal,
    notify: (event) => { relay(event, session) },
    prompt: prompt => session.prompt(restate(prompt)),
  }
  const credential = await oauth.login(interaction)
  await pool.add(undefined, credential, session.signal)
}
