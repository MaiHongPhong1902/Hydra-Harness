/**
 * The model-facing `web_search` tool: discover current information on the web.
 * Execution goes through `ctx.web` — this module owns only the model-facing
 * schema, argument validation, the result-count bound, and result formatting,
 * never provider selection or network access.
 */

import type { Context } from '@hydra/cordis'
import { defineTool } from '@hydra/harness-tools'
import type { GenericCallView, JsonValue, ToolResult, WebSearchResultView, WebSource } from '@hydra/harness-tools'
import type { WebSearchResult, WebSearchSource } from '@hydra/harness-web'
import { normalizedSearchUrl, SearchProviderError } from '@hydra/harness-web'
import type {} from '@hydra/harness-system-prompt'

/**
 * Default upper bound on returned sources (the `searchMaxResults` config).
 * Owned by the consumer (not the provider or model), mirroring `@hydra/harness-tool-fs`'s
 * `READ_LIMIT`. The model just asks a question; the product controls how much
 * context returns. The default `8` aligns with OpenCode's Exa default.
 */
export const WEB_SEARCH_MAX_RESULTS = 8

/** Default upper bound on concurrent searches in one tool call. */
export const WEB_SEARCH_MAX_QUERIES = 4

/** Model-facing `web_search` arguments. */
interface WebSearchArgs {
  queries: string[]
  country?: string
  language?: string
}

/**
 * Validate value constraints the schema DSL can't express: `queries` is
 * non-empty, contains only non-blank strings, and fits the deployment's
 * query-count bound. Exact duplicate strings are collapsed after the bound
 * check. Locale hints must use country/language code syntax. Throws a plain `Error` otherwise.
 *
 * @param args - the schema-validated `web_search` arguments.
 * @param maxQueries - the deployment's upper bound on queries in one call.
 * @returns deduplicated queries and normalized optional locale hints.
 */
export function parseSearchArgs(
  args: WebSearchArgs,
  maxQueries: number,
): WebSearchArgs {
  const queries = args.queries
  if (queries.length === 0) throw new Error('queries must contain at least one query')
  if (queries.length > maxQueries) {
    const noun = maxQueries === 1 ? 'query' : 'queries'
    throw new Error(`queries must contain at most ${maxQueries} ${noun}`)
  }
  if (queries.some(query => query.trim().length === 0)) throw new Error('each query must be a non-empty string')
  const country = args.country?.trim().toLowerCase()
  const language = args.language?.trim().toLowerCase()
  if (country !== undefined && !/^[a-z]{2}$/.test(country)) throw new Error('country must be a two-letter country code, or omitted')
  if (language !== undefined && (language.length > 35 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language))) {
    throw new Error('language must be a language code such as vi, en, or zh-cn, or omitted')
  }
  return { queries: [...new Set(queries)], ...country === undefined ? {} : { country }, ...language === undefined ? {} : { language } }
}

/** Display label for a source: its title, else its hostname. */
function sourceLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title.length > 0) return title
  try {
    return new URL(url).hostname
  } catch {
    // A provider should return a valid URL, but never let a malformed one throw
    // out of pure formatting — fall back to the raw string.
    return url
  }
}

/**
 * Format a search result as one model-facing text block.
 *
 * @param result - the seam's search outcome.
 * @returns the provider answer (when any), a markdown source list with snippet
 *   and date metadata (or `No results found.`), a refine-the-query note when
 *   truncated, and a standing cite-your-sources instruction.
 */
export function formatSearchOutput(result: WebSearchResult): string {
  const parts: string[] = []
  if (result.content !== undefined && result.content.length > 0) parts.push(result.content)

  if (result.sources.length > 0) {
    const lines = result.sources.map((source) => {
      const label = sourceLabel(source.url, source.title)
      const meta: string[] = []
      if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`)
      const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : ''
      return `- [${label}](${source.url})${suffix}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else if (result.content === undefined || result.content.length === 0) {
    parts.push('No results found.')
  }

  if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

/**
 * Pending-call presentation: a search card titled by the query list.
 *
 * @param args - the raw tool arguments; only the query text feeds the view.
 * @returns the generic card view (`kind: 'search'`) shown while the call runs.
 */
export function presentSearchCall(args: WebSearchArgs): GenericCallView {
  const title = args.queries.join(', ')
  return { card: 'generic', title, kind: 'search', rawInput: title }
}

/**
 * The `web_search` tool's private `tool/result` `meta` payload: the structured
 * sources, the optional provider answer, and the truncation flag. Attached
 * opaquely (as `JsonValue`) on the tool result and persisted with the session
 * log, so `presentResult` reproduces the search card on replay. This projection
 * is the only faithful route to the per-source fields, which the lossy render
 * text cannot carry (the owning rationale is the web-result-card Agent Note).
 */
export interface WebSearchMeta {
  /** The faithful structured sources, in result order. */
  sources: WebSource[]
  /** True when the seam or multi-query merge cut the source list to honor the result cap. */
  truncated: boolean
  /** The provider-generated answer text, when any. */
  answer?: string
}

/**
 * Project one seam source into a plain object that omits every absent optional
 * field. Shared by the canonical `execute` result and its replayable
 * presentation meta so both carry byte-identical source shapes.
 *
 * @param source - one source from the `ctx.web` search outcome.
 * @returns `{ url }` plus each present optional field.
 */
function projectSource(source: WebSearchSource): {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
  provider?: string
  position?: number
  score?: number
} {
  return {
    url: source.url,
    ...source.title !== undefined ? { title: source.title } : {},
    ...source.snippet !== undefined ? { snippet: source.snippet } : {},
    ...source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {},
    ...source.provider !== undefined ? { provider: source.provider } : {},
    ...source.position !== undefined ? { position: source.position } : {},
    ...source.score !== undefined ? { score: source.score } : {},
  }
}

/**
 * Project a validated `web_search` output value into its replayable
 * presentation meta ({@link WebSearchMeta} as opaque JSON).
 *
 * @param value - the canonical `web_search` output value (the seam's result shape).
 * @returns the structured sources, the truncation flag, and the answer when present.
 */
export function searchMetaFromValue(value: WebSearchResult): JsonValue {
  return {
    sources: value.sources.map(projectSource),
    truncated: value.truncated,
    ...value.content !== undefined ? { answer: value.content } : {},
  }
}

/** Whether `value` is a valid {@link WebSource} (defensive narrowing from opaque `meta`). */
function isWebSource(value: unknown): value is WebSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { url, title, snippet, publishedAt } = value as Record<string, unknown>
  return typeof url === 'string'
    && (title === undefined || typeof title === 'string')
    && (snippet === undefined || typeof snippet === 'string')
    && (publishedAt === undefined || typeof publishedAt === 'string')
}

/**
 * Narrow opaque live or replayed result metadata to a {@link WebSearchMeta}.
 * Malformed metadata returns `undefined` so presentation can fall back to the
 * generic card instead of throwing during replay.
 *
 * @param meta - result metadata.
 * @returns the validated search meta, or `undefined` for absent or malformed data.
 */
export function searchMetaFromResult(meta: unknown): WebSearchMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { sources, truncated, answer } = meta as Record<string, unknown>
  if (!Array.isArray(sources) || !sources.every(isWebSource)) return undefined
  if (typeof truncated !== 'boolean') return undefined
  if (answer !== undefined && typeof answer !== 'string') return undefined
  return {
    sources,
    truncated,
    ...answer !== undefined ? { answer } : {},
  }
}

/**
 * Completed-call presentation: a `web` search card carrying the faithful
 * structured sources from `meta`. It sets no `content` copy — a UI without the
 * `web` capability falls back to the raw `tool/result` content, which is the
 * same text (see the web-result-card Agent Note).
 *
 * @param args - the raw tool arguments; the queries become the result-state
 *   title so a window-truncated replay that dropped the call head still has one.
 * @param result - the final model-facing tool result; `meta` carries the sources.
 * @returns the search result view, or `undefined` (generic card) on failure or
 *   malformed meta.
 */
export function presentSearchResult(args: WebSearchArgs, result: ToolResult): WebSearchResultView | undefined {
  if (result.isError) return undefined
  const meta = searchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'web',
    kind: 'search',
    title: args.queries.join(', '),
    sources: meta.sources,
    truncated: meta.truncated,
    ...meta.answer !== undefined ? { answer: meta.answer } : {},
  }
}

/**
 * Run one or more searches through the web seam. A single query keeps the
 * provider's exact result; multiple queries run concurrently and are merged
 * into one normalized result capped at `maxResults`. A failed search aborts
 * its siblings, and this function waits for every search to settle before
 * rethrowing the first failure.
 *
 * @param ctx - context whose `web` service performs the searches.
 * @param args - validated queries and optional locale hints shared by the batch.
 * @param maxResults - the deployment's source cap for the combined result.
 * @param signal - cancellation signal forwarded to every search.
 * @returns the combined search result.
 */
async function runSearchQueries(
  ctx: Context,
  args: WebSearchArgs,
  maxResults: number,
  signal: AbortSignal,
): Promise<WebSearchResult> {
  const { queries, ...locale } = args
  if (queries.length === 1) {
    return ctx.web.search({
      query: queries[0] as string,
      maxResults,
      ...locale,
    }, signal)
  }
  const controller = new AbortController()
  const batchSignal = AbortSignal.any([signal, controller.signal])
  let firstFailure: { error: unknown } | undefined
  const results: WebSearchResult[] = []
  const searches = queries.map(async (query, index) => {
    try {
      results[index] = await ctx.web.search({
        query,
        maxResults,
        ...locale,
      }, batchSignal)
    } catch (error) {
      if (firstFailure === undefined) firstFailure = { error }
      controller.abort(error)
      throw error
    }
  })
  await Promise.allSettled(searches)
  if (firstFailure !== undefined) throw firstFailure.error
  return mergeSearchResults(queries, results, maxResults)
}

/** Merge per-query results into one deduplicated, round-robin, capped result. */
function mergeSearchResults(
  queries: string[],
  results: WebSearchResult[],
  maxResults: number,
): WebSearchResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  let sourceRanks = 0
  for (const result of results) {
    sourceRanks = Math.max(sourceRanks, result.sources.length)
  }
  let droppedSource = false
  merge: for (let rank = 0; rank < sourceRanks; rank++) {
    for (const result of results) {
      const source = result.sources[rank]
      if (source !== undefined && !seen.has(normalizedSearchUrl(source.url))) {
        seen.add(normalizedSearchUrl(source.url))
        if (sources.length === maxResults) {
          droppedSource = true
          break merge
        }
        sources.push(source)
      }
    }
  }
  const contents = results.flatMap((result, index) => {
    if (result.content === undefined || result.content.length === 0) return []
    return [`### ${queries[index]}\n\n${result.content}`]
  })
  return {
    ...contents.length > 0 ? { content: contents.join('\n\n') } : {},
    sources,
    truncated: results.some(result => result.truncated) || droppedSource,
  }
}

/**
 * Register the `web_search` tool and its system-prompt guidance.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param maxResults - the deployment's source cap, sent as every seam
 *   request's `maxResults`.
 * @param maxQueries - the deployment's query cap enforced before provider calls.
 * @param timeoutMs - the cooperative tool-call budget (ms) attached as the tool's
 *   `ToolDefinition.timeoutMs` for `@hydra/harness-tool-call-timeout-policy` to enforce.
 * @param fetchEnabled - whether the same composition exposes `web_fetch`, which
 *   controls whether search guidance may recommend that follow-up tool.
 */
export function applyWebSearchTool(
  ctx: Context,
  maxResults: number,
  maxQueries: number,
  timeoutMs: number,
  fetchEnabled: boolean,
): void {
  ctx.systemPrompt.section({
    name: 'tool:web_search',
    order: 110,
    text: fetchEnabled
      ? 'Use the web_search tool to discover current information on the web. The required queries array accepts non-empty search queries within the configured per-call limit; use a one-item array for a single search. Infer country and language from the user request when relevant. Use the requested location or market for country, not the prompt language alone; omit hints without enough context. It returns an optional answer plus a list of source URLs. Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links.'
      : 'Use the web_search tool to discover current information on the web. The required queries array accepts non-empty search queries within the configured per-call limit; use a one-item array for a single search. Infer country and language from the user request when relevant. Use the requested location or market for country, not the prompt language alone; omit hints without enough context. It returns an optional answer plus a list of source URLs. Use the returned source snippets when available, and cite the relevant URLs as markdown links.',
  })

  const tool = defineTool({
    name: 'web_search',
    description: 'Search the web for current information. Provide non-empty queries in the required queries array within the configured per-call limit. Returns an optional summary answer and a list of source URLs.',
    parameters: {
      queries: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Required non-empty search queries; merges their results within the configured per-call limits.',
      },
      country: {
        type: 'string',
        description: 'Optional two-letter country code inferred from the requested search location or market, such as vn or us. Omit when unspecified; do not infer location from language alone.',
      },
      language: {
        type: 'string',
        description: 'Optional search language inferred from the prompt, such as vi, en, or zh-cn. Follow explicit language requests; omit when unclear.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
                provider: { type: 'string' },
                position: { type: 'number' },
                score: { type: 'number' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    timeoutMs,
    // Provider reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const preferences = ctx.web.searchPreferences()
      const parsed = parseSearchArgs(args, preferences?.maxQueries ?? maxQueries)
      const { queries } = parsed
      const started = Date.now()
      let result: WebSearchResult
      try {
        result = await runSearchQueries(ctx, parsed, preferences?.maxResults ?? maxResults, exec.signal)
      } catch (error) {
        ctx.logger('web-search').info('provider=%s queries=%d duration=%d results=0 status=%s retries=0 error=%s',
          preferences?.provider ?? 'standalone', queries.length, Date.now() - started,
          error instanceof SearchProviderError ? error.statusCode ?? '-' : '-',
          error instanceof SearchProviderError ? error.code : 'UNKNOWN')
        throw error
      }
      ctx.logger('web-search').info('provider=%s queries=%d duration=%d results=%d retries=0',
        preferences?.provider ?? 'standalone', queries.length, Date.now() - started, result.sources.length)
      return {
        ...result.content !== undefined ? { content: result.content } : {},
        sources: result.sources.map(projectSource),
        truncated: result.truncated,
      }
    },
    presentCall: presentSearchCall,
    presentResult: (args, result) => presentSearchResult(args, result),
  })
  Object.defineProperty(tool, 'timeoutMs', { get: () => ctx.web.searchPreferences()?.timeoutMs ?? timeoutMs })
  ctx.tools.register(tool)
}
