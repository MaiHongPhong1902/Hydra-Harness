# @hydraharness/harness-web

The **`WebRuntime`** (`ctx.web`) defines WHAT web access the harness has — search the web, fetch a URL — over multiple providers, without binding the model contract to one vendor's API shape.

This package owns the Service Definition role of the web capability. Unlike shell/fs it spans two operations (search and fetch) on one seam, with potentially multiple providers each:

| Package | Role |
|---|---|
| `@hydraharness/harness-web` (this) | Service Definition: the service, provider registries, selection policy, request/result vocabulary, the `WebError` taxonomy |
| `@hydraharness/harness-web-search-exa` | Search provider: Exa |
| `@hydraharness/harness-web-search-perplexity` | Search provider: Perplexity |
| `@hydraharness/harness-web-fetch-http` | Fetch provider: anonymous public HTTP(S) |
| `@hydraharness/harness-tool-web` | Consumer: the model-facing `web_search` / `web_fetch` tool schemas over `ctx.web` |

Search and fetch share no request schema and no business logic, but they are deliberately one seam: `ctx.web` is a single web-access middle layer with one provider-selection policy owner, one abort/error vocabulary, and one product-facing "how this harness reaches the web" config surface. The `Search`/`Fetch` method pairs are deliberately parallel.

## Service API (`ctx.web`)

| Member | Semantics |
|---|---|
| `registerSearchProvider(provider)` / `registerFetchProvider(provider)` | Register a backend. Throws `WebError` `WEB_DUPLICATE_PROVIDER` on a duplicate id within that capability kind. Returns a disposer. Disposed with the calling fiber. |
| `search(request, signal?)` | Resolve the search provider and run one search. Enforces `request.maxResults` on the result (truncates `sources[]`, sets `truncated`). Throws `WebError` when the capability cannot run. |
| `fetch(request, signal?)` | Resolve the fetch provider and retrieve one URL. A non-2xx response is a result, not a throw. Throws `WebError` for failures to safely retrieve or represent the resource. |

Providers register **capabilities**, not tools. `@hydraharness/harness-tool-web` is the only owner of model-facing names, descriptions, prompt guidance, JSON schemas, and presentation.

## Product search settings

The base bundle sets `requireSearchSelection: true`. The `web-search` namespace stores `enabled` (true), `provider` (empty), `maxQueries` (4), `maxResults` (8), and `timeoutMs` (60000). Empty selection and disabled search fail as `CONFIG_ERROR`. Provider selection is independent of chat and takes effect on the next call. Product mode never runs fallback providers.

An explicit legacy DeepSeek search section initializes the selected provider to `deepseek-official`; an existing chat credential alone does not. The initialized empty selection is persisted so configuring a provider later does not trigger migration. An explicit composition `searchProvider` seeds selection. Read-only settings retain the composition choice and cannot persist migration.

Providers optionally declare a descriptor with supported search types, a settings namespace, a credential reference, and control metadata. `listSearchProviders()` feeds Settings; `testSearchProvider()` executes a small real query against saved configuration. DeepSeek, Serper, and Other advertise only web search. Exa and Perplexity remain available to explicit compositions, without MVP Settings controls.

Product search failures expose `SearchProviderError`: provider id, safe message, retryable flag, optional HTTP status, and one of `AUTH_ERROR`, `RATE_LIMITED`, `TIMEOUT`, `NETWORK_ERROR`, `INVALID_RESPONSE`, `CONFIG_ERROR`, or `UNKNOWN`. Logs contain provider, query count, duration, normalized result count, status, retries, and category. Credentials and upstream exception text are excluded.

Normalized sources retain optional provider, position, and score. Duplicate comparison removes fragments and common tracking parameters. URL parsing normalizes host spelling, default ports, and root slashes; non-root trailing slashes remain distinct because servers may serve different resources. The tool merges query results in rank order and applies the total cap.

## Standalone selection

Selection never depends on registration, config, or HMR order. Search and fetch use their own explicit provider ids (config `searchProvider`/`fetchProvider`, or env `$HYDRA_WEB_SEARCH_PROVIDER`/`$HYDRA_WEB_FETCH_PROVIDER` feeding the same fields), or auto-select when exactly one usable provider is registered. The active LLM provider does not participate in web-provider selection. `search()`/`fetch()` resolve at execution time:

| Situation | Execution |
|---|---|
| configured id registered and `available()` | runs that provider |
| configured id not registered | `WEB_PROVIDER_CONFIGURED_MISSING` |
| configured id registered but unavailable | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| no id, exactly one registered usable provider | runs it |
| no id, no usable provider | `WEB_PROVIDER_UNAVAILABLE` |
| no id, multiple usable providers | `WEB_PROVIDER_AMBIGUOUS` |

The failure branches throw `WebError`, whose structured code (plus message detail — the missing id, the ambiguous candidate set) is the direct callers route on. A provider's own `available()` is a cheap local check (credential presence, parseable config) that feeds this execution-time selection and **must not make network calls**; `@hydraharness/harness-tool-web` never calls it — the tool executes through `ctx.web.search()`/`fetch()` and routes on the thrown codes, so provider selection has one owner.

## Vocabulary

`WebSearchRequest` (`query`, `maxResults?`) → `WebSearchResult` (`content?`, `sources[]`, `truncated`); each `WebSearchSource` has a required `url` and optional `title`/`snippet`/`publishedAt` (Perplexity citations may be URL-only). `WebFetchRequest` (`url`) → `WebFetchResult` (final `url`, `statusCode`, `body`, `truncated`); cancellation is a direct optional `AbortSignal` argument to `search()`/`fetch()`. `WebFetchBody` is a CLOSED discriminated union (`html` | `text`) owned here — consumers `switch` to exhaustiveness so a new kind breaks their compilation until handled. See `src/types.ts` for the full contracts and the `WebError` code taxonomy.

`searchFallbackProviders` optionally lists backups for an explicit `searchProvider`. The complete chain must name registered, distinct providers. Each provider runs at most once under the same caller signal. Provider availability, credentials, and provider failures may advance the chain; cancellation, destination denial, configuration errors, and non-WebError exceptions do not. Empty results are successful. The default chain is empty.

## Model Experience

Indirectly, through `@hydraharness/harness-tool-web`, which retains bounded normalized provider data or the exact configured-provider, unavailable-provider, no-provider, multiple-provider, and `Error: <message>` failures while this registry contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- Provider descriptors describe configuration and implemented search types; credential status remains owned by the credentials subsystem.
- Domain filtering and provider-specific search depth remain outside the common request.
- **`WebFetchBody` has no `pdf` arm** — text-extractable PDF support is named deferred work; the closed union makes adding it a compile-enforced change across the three web packages.
- **Provider-backed page extraction is out of scope of `fetch()`** — a Firecrawl/Tavily-style `web_extract` capability is deferred rather than widening the fetch operation.
