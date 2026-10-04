# Agent Note: Generative model endpoint discovery and rejection-only fallback

Status: implemented

## Problem

A provider model listing can include dedicated image or video models alongside conversation models. Assigning the provider's conversation protocol to every listed id makes the selector offer models that reject chat requests, while independent image-tool credentials ignore a working configured gateway.

## Decision

Model metadata carries relative endpoint paths through discovery, settings adoption, catalog queries, and exact-model resolution. Gateway endpoint metadata wins over known OpenAI family hints; unknown ids remain advisory. Fetch reads the live listing without sending a generation probe; API-key profiles and installed providers supply transport defaults, never substitute model ids. Provider errors preserve the current draft. The default xAI API route and native xAI account route merge image/video resource listings, with resource-derived endpoint metadata for unknown ids. Dedicated media can be adopted when the provider mixes OpenAI conversation protocols; its text models retain their own protocols. Custom gateways retain their own listing semantics. Fetched endpoint metadata is retained when model rows are edited. Conversation dispatch refuses explicitly non-chat models before provider I/O.

The existing LLM adapter seam supplies generation transport rather than a separate provider registry. `generateMedia` selects models advertising the requested image or video endpoint in configured provider/model order, with optional provider restriction and model preference. Each provider owns URL, proxy, headers, and credentials. Image tools retain standalone configuration when no saved candidate exists. Missing credentials and HTTP 401/404/429 advance the sequence; cancellation, safety refusals, timeouts, transport/server errors, and accepted jobs stop it.

The [image presentation decision](../feature/2026-10-02-openai-image-generation.md) continues to own durable raster admission and Native tool presentation. The [conversation recovery decision](2026-06-21-bounded-llm-request-recovery.md) continues to retry the same explicit conversation route; generation fallback is a separate consumer operation.

The Models page has exactly two shared selectors at its top, for image and video, over the configured catalog across all providers, filtered by the [editable generation classification](../feature/2026-10-03-model-generation-classification.md). Get all models adopts one provider's full listing into its draft, retaining existing edits; applying the provider publishes the entries to the selectors for their declared image/video roles. Global roles store provider/model pairs, so duplicate ids on different routes remain distinct. The composer Model menu reads and writes those same settings through the existing describe mirror, with revision-checked writes and immediate accepted-answer publication. A disposable LLM preference reader works across adapter ownership and outranks the tool hint. A missing selection or unsupported transport fails before generation I/O. Selection supplies generation metadata for unknown pi-ai aliases. Native Gemini discovery follows page tokens, and its image transport uses generateContent. Image tools accept either response format with bounded reads and durable raster admission.

Antigravity account adapters own native `streamGenerateContent` image requests, including the `image_gen` request type, project, image request id, and request-time credential refresh. The adapter bounds incoming SSE bytes with the consumer's response limit and combines final parts before image admission. Gemini image family hints survive account discovery and settings adoption. Native host fallback follows only HTTP 404, while account rotation follows HTTP 401/404/429. OpenAI-compatible Gemini proxy routes use Chat Completions image/text modalities; unknown aliases can declare that transport explicitly. Both image consumers accept final inline images in the native Antigravity envelope and proxy Chat Completions reply, with the existing bounded read and atomic attachment admission. Explicit pixel sizes become equivalent Gemini aspect ratios.

Codex's account catalog lists conversation models while its native image endpoint accepts separate GPT Image ids. The account adapter supplements successful live discovery and its default catalog with the two supported image ids, labels them as Codex image endpoint entries, and exposes that provenance in Settings. A discovery failure still fails rather than substituting this supplement. Fetch establishes no image entitlement and initiates no image request. Native image calls refresh the selected OAuth grant under the account-store lock, retain its account id, and use `/backend-api/codex/images/generations`. Existing account rotation and durable image presentation apply. Shared selectors refresh on all provider namespace revisions, including account catalog Apply, without discarding pending role selections. Neither the supplement nor this adapter advertises a Codex video endpoint.

## Alternatives considered

**Probe generation endpoints during Fetch.** Rejected because generation can be billed and video creates asynchronous jobs. A successful listing is metadata, not proof of account access.

**Route every id through chat or infer image generation from image input.** Rejected because vision input and generated output require different operations. Explicit endpoint metadata can describe aliases without relying on names.

**Fallback after every failure.** Rejected because a timeout, server error, or lost response can follow accepted generation. HTTP 403 also stops to avoid treating a safety refusal as another-model permission.

## Consequences

Saved gateway credentials serve media generation while the conversation remains on its own chosen model. Generation-only models cannot be selected for chat. Endpoint hints require manual correction for unknown aliases and do not establish quota or model access. Video submission returns an accepted job; polling, durable video storage, and playback remain separate consumer work.

Local HTTP tests cover discovery, adoption, credentials, endpoint routing, image/video rejection fallback, accepted-job termination, and cancellation. The assembled Web scenarios fetch the complete catalog, save image/video selections, and render durable images through OpenAI-compatible fallback or native Gemini transport. Reload preserves the selections and stored images.
