/** Shared search errors, provider configuration metadata, and URL normalization. */

import { WebError } from './types.ts'

/** Search types a provider may explicitly support. */
export type WebSearchType = 'web' | 'images' | 'news' | 'videos' | 'academic'

/** One provider-owned settings control; values live in its settings namespace. */
export interface SearchConfigField {
  key: string
  label: string
  kind: 'text' | 'number' | 'select' | 'json'
  options?: string[]
  advanced?: boolean
  hint?: string
}

/** Secret-free provider metadata used by the Settings directory. */
export interface WebSearchProviderDescriptor {
  id: string
  displayName: string
  description?: string
  capabilities: Record<WebSearchType, boolean>
  configurable: boolean
  settingsNs: string
  credentialRef: string
  fields: SearchConfigField[]
}

/** Web-only capabilities; endpoints for other search types are not advertised. */
export const WEB_SEARCH_CAPABILITIES: Record<WebSearchType, boolean> = {
  web: true, images: false, news: false, videos: false, academic: false,
}

/** Safe categories exposed to tools and configuration UIs. */
export type SearchErrorCode = 'AUTH_ERROR' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'CONFIG_ERROR' | 'UNKNOWN'

const messages: Record<SearchErrorCode, string> = {
  AUTH_ERROR: 'Authentication failed. Replace the API key in Settings > Web Search.',
  RATE_LIMITED: 'Provider quota or rate limit exceeded (HTTP 429).',
  TIMEOUT: 'Search connection timed out.',
  NETWORK_ERROR: 'Could not connect to the search provider.',
  INVALID_RESPONSE: 'Search response format is incompatible with the configured mapping.',
  CONFIG_ERROR: 'Configure the provider and its credential in Settings > Web Search.',
  UNKNOWN: 'Search provider failed.',
}

/** Search failure containing only owned diagnostics, never upstream text or causes. */
export class SearchProviderError extends WebError {
  /** Whether a later retry may succeed without reconfiguration. */
  readonly retryable: boolean

  constructor(
    readonly provider: string,
    override readonly code: SearchErrorCode,
    readonly statusCode?: number,
    message: string = messages[code],
  ) {
    super(message, code)
    this.retryable = ['RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR'].includes(code)
  }
}

/**
 * Translate an HTTP failure without reading an untrusted error body.
 * @param provider - registered provider id.
 * @param status - HTTP status.
 * @returns the normalized failure.
 */
export function searchHttpError(provider: string, status: number): SearchProviderError {
  return new SearchProviderError(provider, status === 401 || status === 403 ? 'AUTH_ERROR'
    : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'NETWORK_ERROR' : 'CONFIG_ERROR', status)
}

/**
 * Remove fragments and common tracking parameters for duplicate detection.
 * Non-root trailing slashes and meaningful query parameters remain distinct.
 * @param value - source URL.
 * @returns a canonical comparison key, or the unchanged malformed URL.
 */
export function normalizedSearchUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|dclid|msclkid)$/i.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    // Legacy providers may supply malformed URLs; comparison remains total.
    return value
  }
}
