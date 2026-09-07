# Agent Note: Confident automatic skill routing

Status: implemented

## Problem

Bounded skill discovery depended on the model calling `skill_search` before exact loading. A model could ignore both tools even when direct user text clearly named a task covered by one installed skill, so the skill body never reached the request and the durable session showed no skill invocation.

## Decision

`@hydra/harness-tool-skill` ranks newly claimed direct-user text at `agent/pre-step` with the same dependency-free lexical metadata scores used by `skill_search`. It automatically injects exactly one model-invocable skill when discovery is complete and the top candidate either appears as an exact whole multi-term skill name or matches at least two distinct name terms including the leading name term. The top score must be unique before lexical name tie-breaking.

An explicit `/name` gesture suppresses automatic routing and retains its user-invocation policy. Automatic discovery and loading fail open on stale, invalid, incomplete, or failing providers, recheck model-invocation policy on the loaded definition, and preserve cancellation. Successful injections use the durable `skill-invocation` source with `trigger: 'automatic' | 'user'`, so session replay distinguishes the route. Weak, generic, description-only, tied, incomplete, and non-user matches load nothing; the model-facing `skill_search` and `skill` tools remain the fallback.

This partially supersedes the search-only separation in [bounded skill routing](../architecture/2026-08-25-bounded-skill-routing.md) without restoring a catalog or an automatic first-match rule.

[Imported skill metadata and conservative routing](2026-09-06-imported-skill-policy-and-routing.md) further narrows automatic confidence with an English/Vietnamese negation veto and counts aliases once per definition. The complete-discovery, strong-match, and durable-provenance rules remain in force.

## Alternatives considered

**Rely only on model tool choice.** Rejected because the observed failure was the model skipping available discovery and loading tools, so better tool wording could not enforce selection.

**Add a skill subagent or auxiliary LLM classifier.** Rejected because it adds latency, cost, recursive composition concerns, and another failure mode while the existing metadata ranker already resolves the reported domain-specific request.

**Load the first lexical match.** Rejected because a generic term, incomplete provider result, or deterministic name tie-break is not enough evidence to add instructions to the request.

## Consequences

Strong unambiguous tasks receive their skill body before the first model request and produce a named durable transcript entry without another model round. Conservative matching still misses synonyms and one-word requests; those cases retain on-demand search. Unit coverage pins confidence, provenance, precedence, incomplete discovery, and provider-policy failures, while the assembled agent-spine snapshot pins the injected request and durable session event.
