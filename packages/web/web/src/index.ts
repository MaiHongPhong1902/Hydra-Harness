/**
 * Service Definition for the web access capability seam (`ctx.web`): registries and provider-selecting execution for search and
 * fetch. Duplicate ids are rejected. At execution time, a configured provider must exist and
 * be usable; without one, exactly one usable provider is required, so selection never depends
 * on registration order.
 * @module @hydraharness/harness-web
 */

import { Context, Service } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { installSettingsSection, settingsNamespace } from '@hydraharness/harness-settings'
import { SearchSettings, type WebSearchSettings } from './settings.ts'
import { normalizedSearchUrl, SearchProviderError, type WebSearchProviderDescriptor } from './search.ts'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export { normalizedSearchUrl, SearchProviderError, searchHttpError, WEB_SEARCH_CAPABILITIES } from './search.ts'
export type { SearchConfigField, SearchErrorCode, WebSearchProviderDescriptor, WebSearchType } from './search.ts'
export type { WebSearchSettings } from './settings.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

declare module '@hydraharness/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** The configured provider id for this capability, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the web seam. `searchProvider` / `fetchProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). Operational overrides such as environment variables
 * must feed these same fields rather than introduce a hidden priority chain.
 */
export interface WebRuntimeConfig {
  /** Product Settings owns selection; no single-provider auto-selection. */
  readonly requireSearchSelection?: boolean
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider?: string
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider?: string
  /** Ordered backup search providers; requires an explicit primary searchProvider. Defaults to none. */
  readonly searchFallbackProviders?: string[]
}

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `WEB_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `WEB_PROVIDER_UNAVAILABLE`.
 */
export class WebRuntime extends Service {
  /**
   * Provider selection config. Operational env overrides feed the SAME fields:
   * `$HYDRA_WEB_SEARCH_PROVIDER` / `$HYDRA_WEB_FETCH_PROVIDER` are equivalent to
   * `searchProvider` / `fetchProvider` and are NOT a hidden priority chain.
   */
  static Config: z<WebRuntimeConfig> = z.object({
    requireSearchSelection: z.boolean().default(false),
    searchProvider: z.string(),
    fetchProvider: z.string(),
    searchFallbackProviders: z.array(z.string()).default([]),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderId: string | undefined
  private readonly fetchProviderId: string | undefined
  private readonly searchFallbackProviders: readonly string[]
  private searchSettings: () => WebSearchSettings
  private readonly requireSearchSelection: boolean

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web')
    this.searchProviderId = config.searchProvider ?? process.env.HYDRA_WEB_SEARCH_PROVIDER
    this.fetchProviderId = config.fetchProvider ?? process.env.HYDRA_WEB_FETCH_PROVIDER
    this.searchFallbackProviders = [...config.searchFallbackProviders ?? []]
    this.requireSearchSelection = config.requireSearchSelection === true
    const settings = SearchSettings({ provider: this.searchProviderId ?? '' })
    this.searchSettings = () => settings
    installSettingsSection(ctx, settingsNamespace('web-search'), SearchSettings, settings, {
      setSource: (source) => { this.searchSettings = source },
      onChange: () => {},
    })
    if (this.searchFallbackProviders.length > 0 && this.searchProviderId === undefined) {
      throw new WebError('searchFallbackProviders requires an explicit searchProvider', 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    const chain = [this.searchProviderId, ...this.searchFallbackProviders]
    if (new Set(chain).size !== chain.length || this.searchFallbackProviders.some(id => id.trim() === '')) {
      throw new WebError('searchFallbackProviders must contain distinct non-empty provider ids excluding the primary', 'WEB_DUPLICATE_PROVIDER')
    }
  }

  /**
   * Read current product limits; standalone compositions retain tool-level limits.
   * @returns saved invocation preferences when product selection is enabled.
   */
  searchPreferences(): WebSearchSettings | undefined {
    return this.requireSearchSelection ? this.searchSettings() : undefined
  }

  /**
   * List provider-owned, secret-free Settings descriptors.
   * @returns configurable providers in registration order.
   */
  listSearchProviders(): WebSearchProviderDescriptor[] {
    return [...this.searchProviders.values()].flatMap(provider => provider.descriptor === undefined ? [] : [provider.descriptor])
  }

  /**
   * Persist the first search selection from explicit legacy configuration only.
   * An explicit empty selection also marks a fresh installation as initialized.
   * @param provider - legacy registered id.
   * @param configured - whether a legacy search section contains explicit settings.
   */
  async migrateSearchSelection(provider: string, configured: boolean): Promise<void> {
    const settings = this.ctx.get('settings')
    if (!this.requireSearchSelection || settings === undefined) return
    const ns = settingsNamespace('web-search')
    const descriptor = settings.describe().find(item => item.ns === ns)
    if (descriptor === undefined || Object.hasOwn(descriptor.user ?? {}, 'provider')) return
    if (!settings.writable) return
    await settings.update(ns, { provider: this.searchProviderId ?? (configured ? provider : '') }, descriptor.revision)
  }

  /**
   * Execute a small real search with a saved provider without changing selection.
   * @param id - registered provider to test.
   * @param signal - caller cancellation.
   * @returns normalized results after validating the provider response.
   */
  async testSearchProvider(id: string, signal?: AbortSignal): Promise<WebSearchResult> {
    return this.runSearchProvider(id, { query: 'Hydra search provider connectivity test', maxResults: 5 }, signal)
  }

  private async runSearchProvider(id: string, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const provider = this.searchProviders.get(id)
    if (provider === undefined || !provider.available()) throw new SearchProviderError(id, 'CONFIG_ERROR')
    const type = request.type ?? 'web'
    if (!(provider.descriptor?.capabilities[type] ?? type === 'web')) {
      throw new SearchProviderError(id, 'CONFIG_ERROR', undefined, `Provider "${id}" does not support ${type} search.`)
    }
    const timeout = AbortSignal.timeout(this.searchSettings().timeoutMs)
    const boundedSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const started = Date.now()
    let result: WebSearchResult | undefined
    let failure: SearchProviderError | undefined
    try {
      const raw = await provider.search(request, boundedSignal)
      const seen = new Set<string>()
      const sources = raw.sources.filter((source) => {
        const key = normalizedSearchUrl(source.url)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).map(source => ({ ...source, provider: id }))
      result = capSources({ ...raw, sources, provider: id, query: request.query }, request.maxResults)
      return result
    } catch (error) {
      if (signal?.aborted) throw new WebError('Web search aborted', 'WEB_ABORTED')
      failure = timeout.aborted ? new SearchProviderError(id, 'TIMEOUT')
        : error instanceof SearchProviderError ? error : new SearchProviderError(id, 'UNKNOWN')
      throw failure
    } finally {
      this.ctx.logger('web-search').info('provider=%s queries=1 duration=%d results=%d status=%s retries=0 error=%s',
        id, Date.now() - started, result?.sources.length ?? 0, result?.statusCode ?? failure?.statusCode ?? '-', failure?.code ?? '-')
    }
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam enforces `request.maxResults` on the result:
   * if the provider over-returns, `sources[]` is truncated and `truncated` set.
   * Configured fallbacks share the caller signal and retry only provider or
   * credential unavailability; missing registrations and cancellation stop the chain.
   * @param request - the query and optional result limit.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's results, capped to `request.maxResults`.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (this.requireSearchSelection) {
      const settings = this.searchSettings()
      if (!settings.enabled) throw new SearchProviderError(settings.provider, 'CONFIG_ERROR', undefined, 'Web Search is disabled in Settings > Web Search.')
      if (settings.provider === '') throw new SearchProviderError('', 'CONFIG_ERROR', undefined,
        'Web Search is enabled but no search provider has been configured. Open Settings > Web Search and select a provider.')
      return this.runSearchProvider(settings.provider, request, signal)
    }
    if (this.searchFallbackProviders.length > 0) {
      const ids = [this.searchProviderId as string, ...this.searchFallbackProviders]
      const providers = ids.map((id) => {
        const provider = this.searchProviders.get(id)
        if (provider === undefined) throw new WebError(`configured web provider "${id}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
        return provider
      })
      let failure: unknown
      for (const provider of providers) {
        if (signal?.aborted) throw new WebError('web search aborted', 'WEB_ABORTED', { cause: signal.reason })
        try {
          if (!provider.available()) throw new WebError(`configured web provider "${provider.id}" is unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
          return capSources(await provider.search(request, signal), request.maxResults)
        } catch (error) {
          const retryable = error instanceof SearchProviderError ? error.retryable
            : error instanceof WebError && [
              'WEB_PROVIDER_ERROR', 'WEB_PROVIDER_CREDENTIAL_MISSING', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
            ].includes(error.code)
          if (signal?.aborted || !retryable) throw error
          failure = error
        }
      }
      throw failure
    }
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
    })
    const result = await provider.search(request, signal)
    return capSources(result, request.maxResults)
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   * @param request - the URL plus retrieval options.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retrieval outcome; non-2xx responses resolve descriptively.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...this.fetchProviderId !== undefined ? { configuredId: this.fetchProviderId } : {},
    })
    return provider.fetch(request, signal)
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

export default WebRuntime
