/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * Discovery always interrogates the provider over the wire. An omitted base
 * URL or protocol inherits the installed provider's transport defaults, never
 * its model list. OpenAI-compatible and native Gemini listings are supported.
 *
 * Discovery does not change the configured catalog. The request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `settings.yaml` remains the only
 * thing that decides what a route serves.
 *
 * Native Gemini listing follows every page token and retains every returned
 * model regardless of generation method. Other protocols report that they
 * cannot be interrogated and keep hand-entry available.
 *
 * @module hydra-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@hydraharness/harness-llm'
import { fetchWithHttpProxy } from '@hydraharness/harness-llm/proxy'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@hydraharness/harness-llm'
import { attributionHeaders } from '@hydraharness/harness-llm'
import { inferModelEndpoints } from '@hydraharness/harness-llm'
import { catalogProvider } from './catalog.ts'

/**
 * Readable model listings: OpenAI's `GET /models` with bearer auth and
 * Gemini's paginated `models` resource with x-goog-api-key. Azure is absent despite its
 * OpenAI lineage — it authenticates with an `api-key` header and requires an
 * `api-version` query — and Codex authenticates through OAuth; guessing at
 * either would report an authentication failure as a provider with no models.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
])

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `hydra-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** One entry of an OpenAI-compatible `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  supported_endpoints?: unknown
  supported_endpoint_types?: unknown
  endpoints?: unknown
}

/** Normalize gateway endpoint metadata while retaining unknown relative paths. */
function endpointsOf(entry: ListingEntry, id: string): string[] | undefined {
  const value = 'supported_endpoints' in entry ? entry.supported_endpoints
    : 'supported_endpoint_types' in entry ? entry.supported_endpoint_types : entry.endpoints
  if (value === undefined) return inferModelEndpoints(id)
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new LlmError(`Model ${id} has invalid endpoint metadata; enter its endpoints by hand.`, 'DISCOVERY_FAILED')
  }
  const aliases: Readonly<Record<string, string>> = {
    'chat-completion': 'chat/completions', 'chat-completions': 'chat/completions',
    'image-generation': 'images/generations', 'image-edit': 'images/edits',
    'video-generation': 'videos',
  }
  return [...new Set((value as string[]).map((item) => {
    const path = item.trim().replace(/^\/?v1\//, '').replace(/^\//, '')
    const endpoint = aliases[path] ?? path
    if (endpoint.includes('://') || !/^[a-zA-Z][a-zA-Z0-9/{}:._-]*$/.test(endpoint)) {
      throw new LlmError(`Model ${id} has invalid endpoint metadata; enter its endpoints by hand.`, 'DISCOVERY_FAILED')
    }
    return endpoint
  }))]
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Join the endpoint base with the listing path. The base is treated as a
 * prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments instead of losing
 * them to `URL` resolution.
 */
function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one OpenAI-compatible listing reply. Entries without a usable id are
 * skipped rather than failing the whole interrogation: a single malformed row
 * should not deny the user the rest of a working endpoint's catalog.
 */
function readListing(body: unknown): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    const id = label(entry?.id)
    if (id === undefined || entry === null) continue
    const name = label(entry.name, entry.display_name)
    const contextWindow = capacity(entry.context_window, entry.context_length)
    const maxTokens = capacity(entry.max_output_tokens, entry.max_tokens)
    const endpoints = endpointsOf(entry, id)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...endpoints === undefined ? {} : { endpoints },
    })
  }
  return models
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedApiKey - the credential the named route already stored, asked
 *   for only when the draft carries none and only on the path that reaches the
 *   network. A configuration surface never holds a stored secret — it edits a
 *   redacted descriptor — so without this an already-configured route would be
 *   interrogated unauthenticated and answer 401.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  storedApiKey?: () => Promise<string | undefined>,
): Promise<readonly LlmDiscoveredModel[]> {
  const installed = request.provider === undefined ? undefined : catalogProvider(request.provider)
  const baseURL = request.baseURL || installed?.baseUrl
  if (baseURL === undefined) {
    throw new LlmError('set a baseURL to fetch models from this provider endpoint', 'DISCOVERY_FAILED')
  }
  const apis = new Set(installed?.getModels().map(model => model.api))
  // Responses and Chat Completions share the same listing resource and auth.
  const api = request.api ?? (apis.size === 1 ? [...apis][0]
    : apis.size > 0 && [...apis].every(value => value === 'openai-completions' || value === 'openai-responses')
      ? 'openai-completions' : installed === undefined ? 'openai-completions' : undefined)
  if (api === undefined) throw new LlmError('set an api to fetch this provider\'s live models', 'DISCOVERY_UNSUPPORTED')
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const xai = installed?.id === 'xai' && baseURL === installed.baseUrl
  const resources = xai ? ['models', 'image-generation-models', 'video-generation-models'] : ['models']
  let resourceIndex = 0
  let url = listingUrl(baseURL)
  const google = api === 'google-generative-ai'
  // Typed credentials test the draft; otherwise the plugin resolves the saved
  // route's references or its provider-native authentication.
  const supplied = request.apiKey ?? await storedApiKey?.()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  const models: LlmDiscoveredModel[] = []
  const tokens = new Set<string>()
  for (;;) {
    let response: Response
    try {
      response = await fetchWithHttpProxy(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...apiKey === undefined ? {} : google ? { 'x-goog-api-key': apiKey } : { authorization: `Bearer ${apiKey}` },
          ...attributionHeaders(),
        },
        ...request.signal === undefined ? {} : { signal: request.signal },
      }, request.proxy)
    } catch (error: unknown) {
      if (request.signal?.aborted) {
        throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new LlmError(
        `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
        'DISCOVERY_FAILED',
      )
    }
    let text: string
    try {
      text = await readBounded(response, url)
    } catch (error: unknown) {
      // Cancellation during the body read rejects with the abort reason, which
      // may be any value; the caller gets the same coded failure it would have
      // for a cancellation before the request went out.
      if (request.signal?.aborted) {
        throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch (error: unknown) {
      throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
    }
    if (!google) {
      const resource = resources[resourceIndex]
      if (resource === 'models') models.push(...readListing(body))
      else {
        const page = body as { models?: unknown } | null
        if (!Array.isArray(page?.models)) throw new LlmError(`${url} answered with no models array`, 'DISCOVERY_FAILED')
        models.push(...readListing({ data: page.models.map((raw: unknown) => {
          const entry = raw as ListingEntry | null
          return { ...entry, endpoints: resource === 'image-generation-models' ? ['images/generations'] : ['videos'] }
        }) }))
      }
      resourceIndex++
      if (resourceIndex >= resources.length) {
        // The dedicated resource enriches ids also advertised by /models.
        const merged = new Map<string, LlmDiscoveredModel>()
        for (const model of models) merged.set(model.id, { ...merged.get(model.id), ...model })
        return [...merged.values()]
      }
      url = `${baseURL.replace(/\/+$/, '')}/${resources[resourceIndex]}`
      continue
    }
    const page = body as { models?: unknown; nextPageToken?: unknown } | null
    if (!Array.isArray(page?.models)) throw new LlmError('Gemini model listing has no models array.', 'DISCOVERY_FAILED')
    models.push(...readListing({ data: page.models.map((raw: unknown) => {
      const entry = raw as {
        name?: unknown
        displayName?: unknown
        inputTokenLimit?: unknown
        outputTokenLimit?: unknown
        supportedGenerationMethods?: unknown
      } | null
      const id = label(entry?.name)?.replace(/^models\//, '')
      const methods = id === undefined ? undefined : endpointsOf({ endpoints: entry?.supportedGenerationMethods }, id)
      const endpoints = (id === undefined ? undefined : inferModelEndpoints(id)) ?? methods?.map(method =>
        method === 'predictLongRunning' ? 'videos' : method === 'predict' ? 'images/generations' : method)
      return {
        id, name: entry?.displayName,
        context_window: entry?.inputTokenLimit, max_output_tokens: entry?.outputTokenLimit,
        ...endpoints === undefined ? {} : { endpoints },
      }
    }) }))
    if (page.nextPageToken === undefined || page.nextPageToken === '') return models
    if (typeof page.nextPageToken !== 'string' || tokens.has(page.nextPageToken)) throw new LlmError('Gemini returned an invalid or repeated model page token.', 'DISCOVERY_FAILED')
    tokens.add(page.nextPageToken)
    const next = new URL(listingUrl(baseURL))
    next.searchParams.set('pageToken', page.nextPageToken)
    url = next.href
  }
}
