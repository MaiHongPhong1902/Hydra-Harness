/** Native subscription providers supplied by pi-ai, retaining their OAuth and wire implementations. */
import { createModels, type Provider } from '@earendil-works/pi-ai'
import type { AuthorizationSession } from '@hydraharness/harness-authorization'
import { resolveProfiles as resolvePiProfiles, type ResolvedPiAiProviderProfile } from '@hydraharness/harness-llm-pi-ai'
import { inferModelEndpoints, LlmError, type LlmDiscoveredModel } from '@hydraharness/harness-llm'
import { emptyAuthContext, type AccountPool } from './accounts.ts'
import { ACCOUNT_PROVIDER_LABELS, type AccountProviderProfile } from './config.ts'
import { accountInteraction } from './interaction.ts'
import { accountJson } from './json-response.ts'

/** Account routes whose native OAuth and streams are owned by pi-ai. */
export type SdkAccountProvider = 'claude' | 'xai-account' | 'kimi'

const nativeIds = { claude: 'anthropic', 'xai-account': 'xai', kimi: 'kimi-coding' } as const

/**
 * Load one native provider without loading unrelated OAuth modules.
 * @param provider - Hydra account route.
 * @returns the provider owning login, refresh, and native streams.
 */
export async function loadSdkAccountProvider(provider: SdkAccountProvider): Promise<Provider> {
  switch (provider) {
    case 'claude': return (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider()
    case 'xai-account': return (await import('@earendil-works/pi-ai/providers/xai')).xaiProvider()
    case 'kimi': return (await import('@earendil-works/pi-ai/providers/kimi-coding')).kimiCodingProvider()
  }
}

/**
 * Obtain a native grant and commit it to the Host account pool.
 * @param provider - account route whose OAuth implementation runs.
 * @param session - authorization interaction and cancellation.
 * @param pool - durable grant owner.
 * @returns once the granted account is stored.
 */
export async function loginSdkAccount(provider: SdkAccountProvider, session: AuthorizationSession, pool: AccountPool): Promise<void> {
  const oauth = (await loadSdkAccountProvider(provider)).auth.oauth
  if (oauth === undefined) throw new LlmError(`${ACCOUNT_PROVIDER_LABELS[provider]} does not offer OAuth.`, 'INVALID_CREDENTIAL')
  const credential = await oauth.login(accountInteraction(session))
  session.signal.throwIfAborted()
  await pool.add(undefined, credential, session.signal)
}

/**
 * Resolve a native SDK provider under its independent account route.
 * @param provider - account provider whose subscription is selected.
 * @param source - optional catalog and request controls.
 * @returns a detached pi-ai profile preserving OAuth and native protocol handling.
 */
export async function buildSdkAccountProfile(
  provider: SdkAccountProvider, source: AccountProviderProfile,
): Promise<ResolvedPiAiProviderProfile> {
  const nativeId = nativeIds[provider]
  const base = await loadSdkAccountProvider(provider)
  const oauth = base.auth.oauth
  if (oauth === undefined) throw new LlmError(`${provider} does not offer OAuth.`, 'INVALID_CREDENTIAL')
  const installed = new Map(base.getModels().map(model => [model.id, model]))
  const baseURL = source.endpoint ?? base.baseUrl
  if (baseURL === undefined) throw new LlmError(`${provider} has no native endpoint.`, 'NO_ADAPTER')
  const profile = resolvePiProfiles({ [nativeId]: {
    ...source.models === undefined ? {} : { models: source.models },
    ...source.models?.some(model => !installed.has(model.id)) ? { api: provider === 'xai-account' ? 'openai-completions' as const : 'anthropic-messages' as const } : {},
    ...source.defaultContextWindow === undefined ? {} : { defaultContextWindow: source.defaultContextWindow },
    ...source.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: source.defaultMaxTokens },
    ...source.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: source.streamIdleTimeoutMs },
    ...source.reasoning === undefined ? {} : { reasoning: source.reasoning },
    ...source.thinkingBudgets === undefined ? {} : { thinkingBudgets: source.thinkingBudgets },
    ...source.cacheRetention === undefined ? {} : { cacheRetention: source.cacheRetention },
    ...source.transport === undefined ? {} : { transport: source.transport },
    ...source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs },
    ...source.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: source.websocketConnectTimeoutMs },
    ...source.retryPolicy === undefined ? {} : { retryPolicy: source.retryPolicy },
    ...source.maxRequestImageBytes === undefined ? {} : { maxRequestImageBytes: source.maxRequestImageBytes },
    baseURL,
  } }).get(nativeId)
  /* v8 ignore next -- resolveProfiles retains every validated input route, including this single native id. */
  if (profile === undefined) throw new LlmError(`${provider} has no native profile.`, 'NO_ADAPTER')
  const models = profile.piProvider.getModels().map(model => ({ ...model, provider, api: installed.get(model.id)?.api ?? model.api }))
  const piProvider: Provider = {
    ...base, id: provider, name: ACCOUNT_PROVIDER_LABELS[provider], auth: { oauth },
    getModels: () => models,
    stream: (model, context, options) => base.stream({ ...model, provider: nativeId }, context, options),
    streamSimple: (model, context, options) => base.streamSimple({ ...model, provider: nativeId }, context, options),
  }
  return { ...profile, provider, baseURL, displayName: ACCOUNT_PROVIDER_LABELS[provider], piProvider }
}

/**
 * Fetch the complete native catalog with the selected account's refreshed OAuth grant.
 * @param provider - subscription route.
 * @param pool - Host-owned account pool and locked refresh store.
 * @param profile - native endpoint and provider implementation.
 * @param signal - optional catalog cancellation.
 * @returns provider model rows with conservative generation endpoint hints.
 */
export async function discoverSdkAccountModels(
  provider: SdkAccountProvider, pool: AccountPool, profile: ResolvedPiAiProviderProfile, signal?: AbortSignal,
): Promise<LlmDiscoveredModel[]> {
  const bounded = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(profile.timeoutMs ?? 30_000)])
  const account = (await pool.accounts.list())[0]
  if (account === undefined) throw new LlmError(`${provider} has no connected account.`, 'MISSING_CREDENTIAL')
  return pool.withAccount(account.id, async () => {
    const models = createModels({ credentials: pool.credentials, authContext: emptyAuthContext })
    models.setProvider(profile.piProvider)
    const auth = (await models.getAuth(provider))?.auth
    if (auth === undefined) throw new LlmError(`${provider} has no connected account.`, 'MISSING_CREDENTIAL')
    const base = profile.baseURL
    if (base === undefined) throw new LlmError(`${provider} has no catalog endpoint.`, 'NO_ADAPTER')
    const url = new URL(`${base.replace(/\/+$/, '')}/${provider === 'xai-account' ? 'models' : 'v1/models'}`)
    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new LlmError('Account catalog endpoint must use HTTPS or loopback HTTP.', 'INVALID_ENDPOINT')
    const result = new Map<string, LlmDiscoveredModel>()
    const resources = provider === 'xai-account' ? [
      { path: 'models', endpoint: undefined },
      { path: 'image-generation-models', endpoint: 'images/generations' },
      { path: 'video-generation-models', endpoint: 'videos' },
    ] : [{ path: 'v1/models', endpoint: undefined }]
    for (const resource of resources) {
      url.pathname = `${new URL(base).pathname.replace(/\/+$/, '')}/${resource.path}`
      url.search = ''
      const cursors = new Set<string>()
      for (;;) {
        const response = await fetch(url, { redirect: 'error', signal: bounded, headers: {
          ...auth.headers, ...auth.apiKey === undefined ? {} : { Authorization: `Bearer ${auth.apiKey}` },
          ...provider === 'claude' ? { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' } : {},
        } })
        if (!response.ok) { await response.body?.cancel(); throw new LlmError(`${provider} model discovery failed (HTTP ${response.status}).`, 'DISCOVERY_FAILED', { status: response.status }) }
        const data = await accountJson(response, bounded)
        const rows = data[resource.endpoint === undefined ? 'data' : 'models']
        if (!Array.isArray(rows)) throw new LlmError(`${provider} model listing has no data.`, 'DISCOVERY_FAILED')
        for (const row of rows as unknown[]) {
          if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string' || row.id === '') throw new LlmError(`${provider} returned an invalid model id.`, 'DISCOVERY_FAILED')
          const endpoints = resource.endpoint === undefined ? inferModelEndpoints(row.id) : [resource.endpoint]
          result.set(row.id, { ...result.get(row.id), id: row.id, ...'display_name' in row && typeof row.display_name === 'string' ? { name: row.display_name } : {}, ...endpoints === undefined ? {} : { endpoints } })
        }
        if (data['has_more'] !== true) break
        const cursor = data['last_id']
        if (typeof cursor !== 'string' || cursor === '' || cursors.has(cursor)) throw new LlmError(`${provider} returned invalid catalog pagination.`, 'DISCOVERY_FAILED')
        cursors.add(cursor)
        url.searchParams.set('after_id', cursor)
      }
    }
    return [...result.values()]
  })
}
