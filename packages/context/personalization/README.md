# @hydraharness/harness-personalization

Personality preference for the system prompt: `friendly`, `pragmatic` (default), or `none`. The value lives in one settings namespace (`personalization`), registered through the generic `ctx.settings` seam so the browser reads and writes it via the already-existing `settings.describe`/`settings.mutate` RPCs — this package adds no RPC of its own.

The Settings UI exposes a global preference. At session start, a session without a logged personality or any `step/start` adopts that preference, recording non-default values as `personalization/personality`. A resumed or forked session with prior steps preserves its existing tone, including the implicit `pragmatic` default. [`resolveSessionPersonality`](src/session.ts) reads the last logged selection and falls back to `pragmatic` when none exists. Later settings edits cannot reinterpret a tone already used in a model request.

The `none` value contributes no prompt text; `friendly` and `pragmatic` each contribute a short tone fragment through `ctx.systemPrompt.section()` (order `10`, just after `deployment:persona` at order `0`).

Explicit local memories are limited to 100 entries, 2,000 characters per entry, and a 32 KiB UTF-8 document; malformed or oversized files fail closed before prompt recall.

## Model Experience

### Personality tone fragment

#### What the model sees

One sentence setting response tone, present unless the session's resolved personality is `none`.

##### Friendly

```markdown
Adopt a warm, encouraging, conversational tone in your responses.
```

##### Pragmatic

```markdown
Adopt a direct, matter-of-fact tone: prioritize clarity and actionable substance over pleasantries.
```

#### Token effect

Fixed, small (one sentence), present for `friendly` and `pragmatic`; zero for `none`.

#### KV Cache effect

Prefix-stable within a session: the resolved personality is fixed by the session's own log the first time an agent starts it, so the section's text does not change across turns of the same session even if the global preference changes later.

## Known Limitations and Deferred Work

- **The `minimal` preset's `complete: true` persona removes this section** — `apps/cli/config/agent-presets/minimal/agent.cordis.yml` marks its persona row `complete: true`, which makes `SystemPrompt.assemble()` discard every other section, including `personalization:personality`, after the waterfall runs. Personality has no effect under that preset (or any composition with an effective `complete: true` section); a deployment that needs both must not mark its persona complete.
- **Personality is a default for unstarted chats** — changing it does not alter the tone of a chat that has entered a model step, including resumed or forked chats.
- **The Settings UI cannot target one running session** — `settings.section` registers at global (`root`) scope (see [the slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md)), so a personality change never writes to "the current conversation" directly; it always goes through the global settings namespace, adopted by sessions at their own next start.
- **Local memories are Hydra-home global** — every top-level chat under one Hydra home reads the same bounded file; workspace and account partitioning is not provided.
