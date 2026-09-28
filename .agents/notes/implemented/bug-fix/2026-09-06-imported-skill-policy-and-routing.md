# Agent Note: Imported skill metadata and conservative routing

Status: implemented

## Problem

Imported skill frontmatter was parsed one line at a time, so Ponytail's folded descriptions became the literal `>` marker. The provider also assigned both invocation permissions unconditionally. Registry aliases consumed separate search slots, and a strong skill-name match could inject instructions even when the user asked not to use them.

## Decision

Filesystem and imported-plugin providers share `parseSkillDocument` from `@hydraharness/harness-skill`. It uses the existing YAML dependency and the established invocation-policy coercion. Invalid imported metadata rejects installation or enablement; the filesystem provider retains its warning-and-skip behavior. Imported exact loads reparse the current policy and reject a renamed document. Discovery and loading therefore enforce the same permissions without relying on immutable-cache conventions to protect against an external file edit.

Alias summaries carry the registry-owned `aliasFor` name. Search and automatic routing rank all visible names, prefer an alias on equal scores, and retain one match per canonical definition before limits or confidence checks. The registry keeps aliases available for exact loading and user commands; native names and competing aliases retain their existing precedence.

Automatic routing skips requests containing common English or Vietnamese negation and avoidance cues. The veto applies to the whole request, so an unrelated negative clause can also defer selection to the model. Explicit slash gestures retain their direct invocation semantics. This narrows the confidence policy in [automatic skill routing](2026-08-28-confident-automatic-skill-routing.md); the [bounded search](../architecture/2026-08-25-bounded-skill-routing.md), [invocation policy](../feature/2026-07-28-skill-invocation-policy.md), and [imported plugin lifecycle](../feature/2026-09-01-codex-compatible-imported-plugin-runtime.md) decisions remain active because their independent rationale still applies.

## Alternatives considered

**Duplicate the YAML and policy parser in the importer.** Rejected because both providers consume the same format and separate coercion can silently grant a disabled invocation permission.

**Remove aliases from the registry.** Rejected because user commands and exact loading need stable short names; duplication belongs to ranked discovery, which can choose the best name for the task.

**Infer general intent from lexical matches.** Rejected because a matching name does not distinguish a request from a prohibition or explanation. The conservative veto addresses common negative requests without adding a classifier; broader language understanding remains with model-led discovery.

## Consequences

Enabled plugins retain useful multiline routing metadata and honor both invocation controls. Each definition occupies one search slot. The automatic veto can miss other languages or phrasing and can suppress otherwise useful automatic loading; it makes no general intent-understanding promise.

Package regressions cover YAML, malformed policy rejection, definition reloads, alias identity, and negative requests. The imported-skills Loader snapshot boots the shipped base composition, exercises search and loading, and compares model requests with durable skill-invocation messages for automatic, negated, user-only, and model-only cases.
