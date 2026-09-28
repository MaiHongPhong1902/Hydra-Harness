# @hydraharness/harness-web-search-http

Serper and Other JSON HTTP search providers for [`ctx.web`](../web/README.md). They share transport and mapping mechanics but retain separate configuration and credentials. Mounting the plugin performs no network calls.

## Configuration

`web-search-serper` owns the result limit (8), request bounds, and the `SERPER_API_KEY` credential reference. Requests use POST `https://google.serper.dev/search`, `X-API-KEY`, and `{q,num}` plus `gl`/`hl` only when the agent supplies country/language hints. Hydra applies no saved locale defaults. Organic title/link/snippet/position fields become normalized sources.

`web-search-custom` owns the endpoint, display name, GET/POST method, authentication, request fields, and response paths. Empty endpoint is unconfigured. Authentication supports none, Bearer, API key header, and custom header; all values resolve through the existing credential service, defaulting to `CUSTOM_SEARCH_API_KEY`. GET encodes fields as query parameters; POST sends JSON. Nested GET values are JSON strings.

Request mapping includes query and limit plus optional country, language, type, and date fields. Response mapping includes results, title, URL, snippet, published date, score, and position. Dot paths permit simple identifiers and reject prototype traversal and expressions. The results path must name an array; each result needs an HTTP(S) URL. Incorrect configured mappings fail the connection test and search as `INVALID_RESPONSE`.

Advanced `headerRefs` JSON maps header names to credential references, never literals. `staticBody` accepts non-secret JSON fields; credential-like names are rejected. Endpoints cannot contain userinfo or credential-like query parameters. Redirects are refused before forwarding credentials. Responses are limited to `maxResponseBytes` (5,000,000 by default) before JSON parsing. Provider timeouts default to 60000 ms and combine with caller cancellation. Keys are resolved for every operation and never retained on the provider. Responses echoing a resolved credential are rejected before returning sources.

## Model Experience

### Conversation search results

#### What the model sees

The [`tool-web`](../tool-web/README.md) consumer emits bounded normalized sources or shared safe errors. Registration adds no model input; Serper and Other do not invoke a language model.

#### Token effect

Result tokens scale with retained source text. Credentials and raw provider responses are excluded.

#### KV Cache effect

Only appended tool results affect subsequent context; switching the provider does not alter the tool argument schema.

## Known Limitations and Deferred Work

- Only web search is implemented. There is no automatic fallback, aggregation across providers, or reranking. Operators choose custom endpoints; private search services are permitted because the endpoint is configuration, not model input. Non-root trailing-slash equivalence is not assumed. Arbitrary expressions and secret literals in static request configuration are unsupported.
