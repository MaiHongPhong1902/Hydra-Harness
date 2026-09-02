# @bosch/bh-personalization

Personality preference for the system prompt: `friendly`, `pragmatic` (default), or `none`. The value lives in one settings namespace (`personalization`), registered through the generic `ctx.settings` seam so the browser reads and writes it via the already-existing `settings.describe`/`settings.mutate` RPCs — this package adds no RPC of its own.

The Settings UI that exposes this preference registers at global (`root`) scope, with no current session to address, so a user's choice is not written to a session directly. Instead, the first time an agent starts a session under a non-default preference, this package logs one `personalization/personality` event to that session — durable provenance for a prompt-affecting fact, per the repo's "model-visible ⟺ logged" rule. A resumed or forked session rebuilds the personality its history was produced under: [`resolveSessionPersonality`](src/session.ts) scans the session's own event log for the last selection, newest winning, and falls back to `pragmatic` only when none was ever logged. Changing the global preference afterward does not retroactively change a session that already logged its own.

The `none` value contributes no prompt text; `friendly` and `pragmatic` each contribute a short tone fragment through `ctx.systemPrompt.section()` (order `10`, just after `deployment:persona` at order `0`).

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
- **No client-facing snapshot pins the personality prompt text** — the two prompt fragments are covered by this package's own real-agent-loop tests, not a keyless ACP/web transcript scenario. A future change to the wording should add one if the exact text becomes product-visible copy worth pinning.
- **The Settings UI cannot target one running session** — `settings.section` registers at global (`root`) scope (see [the slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md)), so a personality change never writes to "the current conversation" directly; it always goes through the global settings namespace, adopted by sessions at their own next start.
