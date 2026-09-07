# Agent Note: Public web retrieval and shared research budgets

Status: implemented

## Problem

Reading public documentation through a browser consumes an interactive runtime. Enabling the existing HTTP fetcher requires address-level protection; checking a hostname before an unrelated DNS lookup leaves a rebinding gap. Recursive research also needs shared admission accounting, and a URL alone does not identify the content supporting a citation.

## Decision

The HTTP provider validates public destinations inside its direct dispatcher's socket lookup and passes only that validated address set to the connection. Literal addresses and every redirect receive the same checks. Exact operator-configured origins grant access to private services; the model cannot supply these exceptions. The base bundle mounts the provider, and Standard and Code expose fetch.

Fetch converts and bounds text before returning it. A SHA-256 of the URL and rendered content identifies the source version. Passage citations use a source URI and an exact quote in the Markdown link title. Chat resolves these against preceding successful native or Code Mode fetch results in its loaded transcript; missing sources and mismatched quotes remain inert. Offsets describe the recorded rendered text, not the original HTML. Matching proves retrieval provenance, not that a claim follows from the passage.

Research charges are written to the live root session before tool dispatch. Continuations and descendants share those charges. Subagent admission reserves tree capacity before asynchronous creation or cold resume, releases it at settlement or rollback, and records cumulative creation attempts separately. The base bundle supplies explicit limits. Unavailable child ancestry is an error rather than a fresh budget.

Standalone search reuses the existing provider registry with an optional explicit fallback sequence. [Product provider selection](2026-09-07-web-search-provider-selection.md) uses the saved provider without fallback. Each provider is attempted once under the caller's existing deadline; cancellation, blocked destinations, missing configured providers, and programmer errors do not trigger fallback. No fallback providers are enabled by default. Local research reports derive timings, tool outcomes, output sizes, and token counts from session logs without uploading content.

## Alternatives considered

**Enable fetch without connection checks.** Rejected because a model-controlled URL could reach localhost or internal services. Resolve-then-fetch with an independent lookup also permits DNS rebinding.

**Build a second search gateway or evidence database.** Rejected because the web registry and durable transcript already own provider selection and retrieved content. A separate store creates consistency and lifecycle work without a current consumer.

**Reset budgets for each child or continuation.** Rejected because delegation and follow-up would multiply spending without bound. Root lifetime limits are deliberately cumulative.

**Intent classification, reranking, and circuit breakers by default.** Deferred until task measurements demonstrate a need; these add cost or hide useful tools and sources without improving a measured failure today.

## Consequences

Public fetch intentionally refuses special-use addresses, transition IPv6 ranges, and cross-origin redirects. Internal origins require an operator grant. Citations whose source lies outside the loaded transcript remain inert until that history is loaded; ordinary URL links remain ordinary links. Process-local admission does not coordinate multiple harness processes, and an unflushed crash tail follows ordinary session durability.

## Verification

Focused tests exercise literal and DNS destination denial, real loopback transport under an exact grant, size limits and cancellation, search fallback, shared charges, admission rollback, and citation rejection. The runnable ACP fetch composition replays the real HTTP and Markdown pipeline with a research policy and a recorded source identity. Chat history replay verifies passage links through the assembled UI. TypeScript and Python SDK snapshots include delegation admissions; Python verification through the built Node entry does not replace the single-executable packaging check.
