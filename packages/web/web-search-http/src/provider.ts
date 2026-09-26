/** Bounded JSON HTTP requests and simple dot-path mapping for search providers. */

import { credentialRef } from '@hydra1902/harness-credentials'
import { SearchProviderError, searchHttpError, WebError } from '@hydra1902/harness-web'
import type { WebSearchProvider, WebSearchProviderDescriptor, WebSearchRequest, WebSearchResult, WebSearchSource } from '@hydra1902/harness-web'

/** Fully resolved, secret-free configuration captured once per request. */
export interface HttpSearchConfig {
  /** Name shown for this configured search service. */
  displayName: string
  /** HTTP(S) search URL; empty means unconfigured. */
  endpoint: string
  /** Query parameters for GET, JSON body for POST. */
  method: 'GET' | 'POST'
  /** Authentication scheme for the primary credential. */
  auth: 'none' | 'bearer' | 'api_key_header' | 'custom_header'
  /** Header receiving the primary key for header authentication. */
  authHeader: string
  /** Credential reference; never a plaintext key. */
  apiKeyEnv: string
  /** Dot-path receiving the search query. */
  queryField: string
  /** Dot-path receiving the provider result cap; empty omits it. */
  limitField: string
  /** Dot-path to the response result array. */
  resultsPath: string
  /** Result title dot-path; empty omits it. */
  titleField: string
  /** Result URL dot-path; must resolve to an HTTP(S) URL. */
  urlField: string
  /** Result excerpt dot-path; empty omits it. */
  snippetField: string
  /** Publication date dot-path; empty omits it. */
  publishedAtField: string
  /** Numeric relevance score dot-path; empty omits it. */
  scoreField: string
  /** Numeric provider rank dot-path; empty omits it. */
  positionField: string
  /** Country request dot-path; empty omits it. */
  countryField: string
  /** Language request dot-path; empty omits it. */
  languageField: string
  /** Search type request dot-path; empty omits it. */
  typeField: string
  /** Date filter request dot-path; empty omits it. */
  dateField: string
  /** JSON object mapping custom header names to credential references. */
  headerRefs: string
  /** JSON object with non-secret constant request fields. */
  staticBody: string
  /** Whole-request deadline in milliseconds, including credentials. */
  timeoutMs: number
  /** Maximum JSON response size in bytes before parsing. */
  maxResponseBytes: number
  /** Provider request limit; the common tool may impose a smaller total. */
  maxResults: number
}

const forbidden = /^(?:__proto__|prototype|constructor)$/
const secretName = /authorization|cookie|password|secret|token|api[-_]?key/i

/** Accept only own-property paths; no indexing, expressions, or prototype traversal. */
function pathParts(path: string): string[] {
  const parts = path.split('.')
  if (!parts.every(part => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) && !forbidden.test(part))) {
    throw new Error('Search mapping paths must contain simple dot-separated field names.')
  }
  return parts
}

/** Parse user JSON without allowing credential-like fields or prototype mutation. */
function objectJson(text: string, headers = false): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Search JSON must be a valid object.') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Search JSON must be an object.')
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.test(key) || (!headers && secretName.test(key))) throw new Error('Store search credentials through the credential controls, not request JSON.')
      visit(child)
    }
  }
  visit(value)
  return value as Record<string, unknown>
}

/**
 * Reject unsafe paths, credential-bearing endpoints, and malformed JSON at save/load.
 * An empty endpoint is a valid unconfigured draft, rejected at execution.
 * @param config - resolved provider configuration.
 */
export function validateSearchConfig(config: HttpSearchConfig): void {
  credentialRef(config.apiKeyEnv)
  if (config.endpoint !== '') {
    let url: URL
    try { url = new URL(config.endpoint) } catch { throw new Error('Search endpoint must be an HTTP(S) URL.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some(key => secretName.test(key))) throw new Error('Search endpoint must be HTTP(S) without embedded credentials or a fragment.')
  }
  for (const path of [config.queryField, config.resultsPath, config.urlField]) pathParts(path)
  for (const path of [config.limitField, config.titleField, config.snippetField, config.publishedAtField, config.scoreField,
    config.positionField, config.countryField, config.languageField, config.typeField, config.dateField]) if (path !== '') pathParts(path)
  if (config.auth !== 'none' && config.auth !== 'bearer') new Headers({ [config.authHeader]: 'validation' })
  for (const [key, ref] of Object.entries(objectJson(config.headerRefs, true))) {
    new Headers({ [key]: 'validation' })
    if (/^(host|content-length|transfer-encoding|connection)$/i.test(key)) throw new Error('Search transport headers cannot be overridden.')
    if (typeof ref !== 'string') throw new Error('Custom header values must be credential references.')
    credentialRef(ref)
  }
  objectJson(config.staticBody)
}

/** Read only own properties from untrusted JSON. */
function at(value: unknown, path: string): unknown {
  if (path === '') return undefined
  for (const part of pathParts(path)) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** Assign one validated dot-path without mutating static input objects. */
function put(target: Record<string, unknown>, path: string, value: unknown): void {
  if (path === '' || value === undefined) return
  const parts = pathParts(path)
  for (const part of parts.slice(0, -1)) {
    const child = target[part]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) target[part] = {}
    target = target[part] as Record<string, unknown>
  }
  target[parts.at(-1) as string] = value
}

/** Shared provider mechanics; provider routing remains in ctx.web. */
export class HttpSearchProvider implements WebSearchProvider {
  readonly id: string

  constructor(
    readonly descriptor: WebSearchProviderDescriptor,
    private readonly current: () => HttpSearchConfig,
    private readonly resolveKey: (ref: string) => Promise<string | undefined>,
  ) { this.id = descriptor.id }

  available(): boolean { return this.current().endpoint !== '' }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const config = this.current()
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const bounded = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let status: number | undefined
    const keys: string[] = []
    try {
      validateSearchConfig(config)
      if (config.endpoint === '' || (request.type !== undefined && request.type !== 'web')) throw new SearchProviderError(this.id, 'CONFIG_ERROR')
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' })
      const keyFor = async (ref: string): Promise<string> => {
        bounded.throwIfAborted()
        const cancelled = Promise.withResolvers<never>()
        const onAbort = () => { cancelled.reject(new SearchProviderError(this.id, 'TIMEOUT')) }
        bounded.addEventListener('abort', onAbort, { once: true })
        let key: string | undefined
        try { key = await Promise.race([this.resolveKey(ref), cancelled.promise]) }
        catch { throw new SearchProviderError(this.id, 'CONFIG_ERROR') }
        finally { bounded.removeEventListener('abort', onAbort) }
        if (!key) throw new SearchProviderError(this.id, 'CONFIG_ERROR')
        keys.push(key)
        return key
      }
      for (const [header, ref] of Object.entries(objectJson(config.headerRefs, true))) headers.set(header, await keyFor(ref as string))
      if (config.auth !== 'none') {
        const key = await keyFor(config.apiKeyEnv)
        headers.set(config.auth === 'bearer' ? 'Authorization' : config.authHeader, config.auth === 'bearer' ? `Bearer ${key}` : key)
      }
      const body = objectJson(config.staticBody)
      put(body, config.queryField, request.query)
      put(body, config.limitField, Math.min(request.maxResults ?? config.maxResults, config.maxResults))
      put(body, config.countryField, request.country)
      put(body, config.languageField, request.language)
      put(body, config.typeField, request.type ?? 'web')
      put(body, config.dateField, request.date)
      const endpoint = new URL(config.endpoint)
      if (config.method === 'GET') {
        for (const [key, value] of Object.entries(body)) endpoint.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value))
      }
      const response = await fetch(endpoint, {
        method: config.method, headers, redirect: 'error', signal: bounded,
        ...config.method === 'POST' ? { body: JSON.stringify(body) } : {},
      })
      status = response.status
      if (!response.ok) {
        await response.body?.cancel()
        throw searchHttpError(this.id, status)
      }
      let payload: unknown
      let bytes = 0
      const bodyStream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          bytes += chunk.byteLength
          if (bytes > config.maxResponseBytes) throw new SearchProviderError(this.id, 'INVALID_RESPONSE', status)
          controller.enqueue(chunk)
        },
      }))
      try { payload = await new Response(bodyStream).json() }
      catch { throw new SearchProviderError(this.id, 'INVALID_RESPONSE', status) }
      const items = at(payload, config.resultsPath)
      if (!Array.isArray(items)) throw new SearchProviderError(this.id, 'INVALID_RESPONSE', status)
      const sources: WebSearchSource[] = items.map((item) => {
        const url = at(item, config.urlField)
        if (typeof url !== 'string' || !URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) throw new SearchProviderError(this.id, 'INVALID_RESPONSE', status)
        const source: { url: string; title?: string; snippet?: string; publishedAt?: string; score?: number; position?: number } = { url }
        for (const [key, path] of [['title', config.titleField], ['snippet', config.snippetField], ['publishedAt', config.publishedAtField]] as const) {
          const value = at(item, path)
          if (value !== undefined && value !== null && typeof value !== 'string') throw new SearchProviderError(this.id, 'INVALID_RESPONSE', status)
          if (typeof value === 'string') source[key] = value
        }
        for (const [key, path] of [['score', config.scoreField], ['position', config.positionField]] as const) {
          const value = at(item, path)
          if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new SearchProviderError(this.id, 'INVALID_RESPONSE', status)
          if (typeof value === 'number') source[key] = value
        }
        return source
      })
      if (keys.some(key => JSON.stringify(sources).includes(key))) throw new SearchProviderError(this.id, 'INVALID_RESPONSE', status)
      return { sources, truncated: false, statusCode: status }
    } catch (error) {
      if (timeout.aborted || (signal?.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')) throw new SearchProviderError(this.id, 'TIMEOUT', status)
      if (signal?.aborted) throw new WebError('Web search aborted', 'WEB_ABORTED')
      if (error instanceof SearchProviderError) throw error
      throw new SearchProviderError(this.id, 'NETWORK_ERROR', status)
    }
  }
}
