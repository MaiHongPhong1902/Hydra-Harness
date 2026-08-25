# @bosch/bh-tool-skill

Bounded model-facing skill discovery, exact instruction loading, and deterministic user invocation.

Requires `ctx.agents`, `ctx.tools`, and `ctx.skills` (`inject: ['agents', 'tools', 'skills']`). The plugin does not inject a session-wide skill catalog or load any skill body automatically.

## Tool: `skill_search`

| Arg | Type | Notes |
|---|---|---|
| `query` | string (required) | Concise task keywords. Greetings, thanks, acknowledgements, casual chat, meta questions, and vague requests should not be searched. |

The tool snapshots the calling agent's cwd-sensitive registry view, keeps only model-invocable summaries, and ranks lexical matches across `name`, `description`, and `whenToUse`. Exact whole-name phrases rank first, then matched terms and metadata fields, with skill name as the deterministic tie-breaker. It does not call `ctx.skills.get()` and therefore never loads instruction bodies while searching.

One result returns at most `searchMaxResults` candidates (default `5`), caps each description or routing hint at `searchDescriptionMaxLength` characters (default `500`), and caps the complete rendered UTF-8 result at `searchMaxResultBytes` bytes (default `8192`). All limits are positive integers; the description limit has minimum `3`, and the byte limit must fit the fixed empty-result framing. `truncated: true` says matching candidates were omitted by a count or byte bound. `complete: false` says provider discovery was unstable or partially unavailable, so an empty result is not authoritative.

The rendered result is:

```markdown
<skill_candidates complete="true" truncated="false">
- `<name>`: <normalized-and-capped-description>
  Use when: <normalized-and-capped-routing-hint>
</skill_candidates>
Choose zero or one candidate. Call `skill` only for the best match; load another only when the task clearly requires an independent skill.
```

An empty complete search renders `(none)` and means no skill should be loaded. This two-step contract keeps model-visible discovery cost bounded even when the registry contains many skills.

## Tool: `skill`

| Arg | Type | Notes |
|---|---|---|
| `name` | string (required) | Exact kebab-case name returned by `skill_search` or explicitly named by the user. |

Execution uses the calling agent's `session.header.cwd`, validates the name, rejects non-model-invocable skills before loading, then rechecks policy on the loaded definition. A successful call returns canonical `{ name, provider, resourceBase?, content }`; its Native renderer produces one text result containing `<skill_content name="...">`, `<skill_resources>`, and `<skill_instructions>`.

Resource guidance resolves only paths or URLs explicitly referenced by the instructions against `resourceBase`. Scripts, references, and assets load on demand; the result does not enumerate a skill directory. An unresolved name reports that the skill is unknown or no longer available. Invalid names and model-disabled skills have distinct errors.

## User-explicit invocation

A whitespace-bounded `/name` token in a claimed direct-user message deterministically loads a user-invocable skill and appends its full `<skill_content>` rendering after the other injections for that step. Tokens from non-user sources cannot forge the gesture; unknown or user-disabled names stay ordinary prose. This is the model-independent path for `disable-model-invocation` skills and does not call `skill_search` or `skill`.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`skill_search` and `skill` schemas](../../../docs/tool-catalog.md#boschbh-tool-skill). No data-dependent skill roster is added to the request prefix.

#### Token effect

Fixed schema cost on each request where the tools are visible.

#### KV Cache effect

Prefix-stable while definitions and visibility remain unchanged.

### Search result

#### What the model sees

A search adds only the bounded candidate result above.

#### Token effect

At most the configured rendered UTF-8 byte limit, retained in later requests until compaction.

#### KV Cache effect

Append-only after the reusable request prefix.

### Loaded result

#### What the model sees

The selected provider's `<skill_content>`, resource guidance, and complete instructions. The tool does not add a duplicate injected copy.

#### Token effect

Data-dependent body tokens are resent on later steps until compaction.

#### KV Cache effect

Append-only after the reusable request prefix.

### Tool errors

#### What the model sees

Invalid or stale selections return `Error: invalid skill name "<name>"`, `Error: skill "<name>" is unknown or no longer available`, or `Error: skill "<name>" is not available for model invocation`. Provider lookup failures use the same `Error: <message>` wrapper.

#### Token effect

Only a failing tool call adds the short retained error text.

#### KV Cache effect

Append-only after the reusable request prefix.

## Known Limitations and Deferred Work

- Search is lexical metadata matching, not semantic retrieval. Add a semantic index only after measured routing misses justify its dependency and operational cost.
- Loaded instruction bodies have no size cap; a provider can return a body that consumes substantial next-step context.
- Resources are guidance, not attachments; the tools neither enumerate nor fetch referenced files.
- Loading is one-shot text; there is no partial, streaming, or cached-content handle.
- Body-only edits do not notify the model. A later exact load reads current content while earlier tool results remain historical facts.
