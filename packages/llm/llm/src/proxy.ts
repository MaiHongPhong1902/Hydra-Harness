/** Per-request HTTP(S) proxy routing for Node LLM adapters. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

const proxyContext = new AsyncLocalStorage<string | undefined>()
// ponytail: provider routes are user-owned and few; add bounded eviction when profile churn becomes measurable.
const agents = new Map<string, ProxyAgent>()
let nativeFetch: typeof fetch | undefined

/**
 * Validate and trim an optional HTTP(S) proxy URL.
 * @param proxy - raw configuration value.
 * @param label - setting name used in diagnostics.
 * @returns the normalized proxy URL, or `undefined` when it is not configured or blank.
 */
export function normalizeHttpProxy(proxy: string | undefined, label = 'proxy'): string | undefined {
  if (proxy === undefined) return undefined
  const value = proxy.trim()
  if (value.length === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    // Never include a raw proxy URL in a diagnostic: it can contain credentials.
    throw new Error(`${label} must be a valid HTTP(S) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`)
  }
  return value
}

function agentFor(proxy: string): ProxyAgent {
  const cached = agents.get(proxy)
  if (cached !== undefined) return cached
  const agent = new ProxyAgent(proxy)
  agents.set(proxy, agent)
  return agent
}

const proxyFetch: typeof fetch = (input, init) => {
  const proxy = proxyContext.getStore()
  if (proxy === undefined) {
    const direct = nativeFetch
    if (direct === undefined) throw new Error('HTTP proxy fetch interceptor is not initialized')
    return direct(input, init)
  }
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...init,
    dispatcher: agentFor(proxy),
  } as Parameters<typeof undiciFetch>[1]) as ReturnType<typeof fetch>
}

function ensureFetchInterceptor(): void {
  if (globalThis.fetch === proxyFetch) return
  nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = proxyFetch
}

/**
 * Run a callback with an HTTP(S) proxy attached only to fetches it starts.
 * @param proxy - optional route proxy.
 * @param callback - request work that may construct an SDK client or consume a stream.
 * @returns the callback result.
 */
export function withHttpProxy<T>(proxy: string | undefined, callback: () => T): T {
  const resolved = normalizeHttpProxy(proxy)
  if (resolved === undefined && proxyContext.getStore() === undefined) return callback()
  ensureFetchInterceptor()
  return proxyContext.run(resolved, callback)
}

/**
 * Fetch through one explicit HTTP(S) proxy without changing process-wide environment settings.
 * @param input - request target.
 * @param init - request options.
 * @param proxy - optional route proxy.
 * @returns the provider response.
 */
export function fetchWithHttpProxy(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  proxy: string | undefined,
): ReturnType<typeof fetch> {
  const resolved = normalizeHttpProxy(proxy)
  if (resolved === undefined) return globalThis.fetch(input, init)
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...init,
    dispatcher: agentFor(resolved),
  } as Parameters<typeof undiciFetch>[1]) as ReturnType<typeof fetch>
}
