# Agent Note: Bounded skill routing before exact loading

Status: implemented

## Problem

The model-facing skill consumer published every model-invocable name and description into durable session history before the first request and republished the whole list after metadata changes. It avoided loading bodies, but prompt cost and routing noise still grew linearly with registry size. A deployment with one hundred skills therefore paid for one hundred summaries even for a greeting, and the broad roster encouraged the model to select instructions when no specialist behavior was needed.

Disabling an overly broad skill fixes one symptom by removing a capability the user may need later. Loading every body is worse. The routing boundary needs to preserve optional skills while bounding what any one decision exposes to the model.

## Decision

`@hydraharness/harness-tool-skill` publishes no automatic skill roster. It exposes two model tools:

- `skill_search({ query })` snapshots only the calling agent's visible registry metadata, filters model-disabled entries, ranks lexical matches across `name`, `description`, and `whenToUse`, and returns a bounded shortlist without calling any provider's `get()` method.
- `skill({ name })` remains the exact body loader. Its accepted name comes from the current search result or an explicit user reference, and invocation policy is checked both before and after loading.

The search schema tells the model to skip discovery for greetings, thanks, acknowledgements, casual chat, meta questions, and vague requests. A complete empty result means load no skill. A non-empty result says choose zero or one candidate; a second load is reserved for an independent task need. Search defaults to five candidates, 500 characters per description or routing hint, and 8192 UTF-8 bytes for the complete rendered result. Count and byte truncation are explicit, while an incomplete provider snapshot preserves its separate `complete: false` meaning.

Ranking is deterministic, dependency-free lexical metadata matching: an exact whole-name phrase wins, then unique matched query terms, matches in the name, `whenToUse`, and description, followed by lexical name order. This is intentionally not a second LLM classifier or embedding service. The existing whitespace-bounded `/name` user gesture remains deterministic and loads a user-invocable skill directly without model search.

Historical `skill-catalog` messages remain valid durable records and the Web transcript retains its generic catalog-form rendering for replay. The current producer emits no new `skill-catalog` message.

The later [confident automatic routing decision](../bug-fix/2026-08-28-confident-automatic-skill-routing.md) permits one host-selected body only for a complete, unique, strong metadata match. Search remains the fallback and no roster is restored.

This supersedes new catalog publication in the [skill-system decision](../feature/2026-07-05-skill-system.md) and the model-facing portion of [skill catalog hot refresh](../feature/2026-07-27-skill-catalog-hot-refresh.md). Registry snapshots, invalidation, filesystem watching, user-facing slash menus, and exact body refresh remain unchanged.

## Alternatives considered

**Disable a broad domain skill.** Rejected because it removes useful task-specific instructions instead of fixing unbounded discovery and over-selection for every provider.

**Keep injecting every summary and rely on the model to ignore most of them.** Rejected because prompt size and attention noise still scale with total skill count before the model makes any decision.

**Inject a host-selected top-N roster before every request.** Rejected because the host has no task query at the pre-step publication point without adding another classifier, and even irrelevant conversational turns would pay for the shortlist.

**Add an LLM classifier, embedding index, or vector database.** Rejected until measured lexical routing misses justify another model call, dependency, index lifecycle, and failure mode.

**Load every matched body or automatically load the first match.** Rejected because retrieval confidence is not authorization to add instructions. Search and exact loading stay separate, and the model may choose zero candidates.

## Consequences

Model-visible discovery has fixed schema cost and bounded per-search result cost rather than a roster proportional to registry size. A strong unambiguous task can load before the first model request under the later automatic-routing decision; other skill-eligible tasks take an extra search round and ordinary conversation takes none. Lexical matching can miss semantic synonyms or cross-language phrasing, so metadata authors need concrete routing terms and semantic retrieval remains a measured upgrade path. Loaded bodies remain uncapped and retain their existing history cost because this decision bounds discovery, not provider-owned instructions.

Unit coverage pins a one-hundred-skill registry to the configured count cap, the total UTF-8 byte cap, deterministic ranking, incomplete discovery, scoped visibility, policy filtering, and zero body loads during search. Agent-spine integration covers both explicit search/loading and confident pre-request injection. The real Loader badge snapshot proves an enabled bundled provider is searchable and loadable while the disabled composition returns no candidate.
