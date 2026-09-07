# Agent Note: Settings → Personalization section

Status: implemented

## Problem

The product needed a "Personalization" area in Settings (custom instructions, a memory status, and a tone/personality selector), modeled on a reference product screenshot. Three sub-problems had no existing owner: (1) reading/writing a free-text document from the browser has no existing RPC (`settings.*` covers only schema-registered namespaces), (2) a global tone preference must still satisfy the repo's "model-visible ⟺ logged" rule even though the Settings UI has no way to address one running session, and (3) Memory has no engine at all and must not pretend otherwise.

## Decision

The instructions editor retains unsaved drafts across section entry and pending saves; explicit reload replaces them. The [Settings lifecycle note](../bug-fix/2026-09-05-settings-draft-and-dialog-lifecycle.md) owns these interaction rules. System prompts groups instructions and personality into native disclosure panels, collapsed on each section entry. Both editors write only on Save. Drafts live with the plugin, so hiding a panel or switching sections does not lose them. A pending personality save clears only the submitted selection if it remains unchanged and the settings scope confirms it; failure retains the draft for retry.

### Custom instructions: `settings.readInstructions` / `settings.writeInstructions`

Two new RPCs on the existing `settings.*` domain (`packages/host/apiproxy/src/api/settings.ts`) read and wholesale-replace `$HYDRA_HOME/AGENTS.md` — the same fixed user-global file `@hydra/harness-agent-instructions` discovers (its `USER_GLOBAL_FILE` constant is now a public export used by the handler). They intentionally do **not** route through `SettingsProvider`/`ctx.settings.register`: that seam models a schema-validated, namespace-registered section with an in-memory monotonic revision counter, while this is one raw text file with no schema. The handler (`packages/host/apiproxy/src/api-proxy.ts`) instead:

- Reads via plain `readFile`, treating `ENOENT` as empty content (no "settings service absent" error — there is no provider to be absent).
- Writes under `@hydra/harness-atomic-write`'s `withFileLock` + `writeFileAtomic` (`mode: 0o600`, `dirMode: 0o700`), mirroring `settings-file`'s own `persistSection`. The parent directory is `mkdir`-created (mode `0700`) **before** acquiring the lock, because `withFileLock`'s `wx`-created `.lock` sibling requires the parent to already exist — the exact ordering `settings-file`'s `persistSection` uses.
- Revisions the raw UTF-8 bytes as a SHA-256 hex digest (`InstructionsDocumentView.revision`), not a namespace counter, because there is no in-memory registration to hold one across restarts. A write's `expectedRevision` is checked against a fresh read taken **inside** the lock (re-reading, not trusting the caller's snapshot), and a mismatch answers `instructions-conflict: { expected, actual }` — the same optimistic-concurrency shape as `settings-conflict`, minus the `ns` field this single document has no use for.
- Enforces the 65,536-byte cap on `Buffer.byteLength(content, 'utf8')`, never `string.length` (raw encoded bytes, not JS UTF-16 code units), answering `instructions-rejected` over the cap or on any other storage failure.
- Is loopback-only via the existing `PRIVILEGED_METHODS` mechanism (`packages/client/connection/src/index.ts`): membership alone pins a method to loopback, because the fence passes privileged methods through `isTrustedApiRequest(request, [])` — an empty trusted-hosts list, so a declared LAN authority that reaches every other method still 403s here.

Every exhaustive table gained both methods: `RpcMethodMap`, `RpcErrorDetailsMap`, the `rpcErrorSchema` discriminated union, `UNARY_ROUTES`, `IApiClient['settings']` + `UNARY_VALUE_SCHEMAS` + `AbstractApiClient.settings`, `PRIVILEGED_METHODS`, the fixture-world `settings` stub and `FixtureApiClient.dispatch()` switch, both `fake-api.client.ts` doubles, `client-handler.spec.ts`'s scripted defaults and round-trip test, and both privileged-method-enumeration tests in `node-half.host.spec.ts`.

### Personality: a settings namespace, adopted into the session log at start

`@hydra/harness-personalization` (`packages/context/personalization`) owns `personality: 'friendly' | 'pragmatic' | 'none'` (default `pragmatic`) as an ordinary `ctx.settings.register`-backed namespace (`personalization`) — reusing the ALREADY-COMPLETE `settings.describe`/`mutate` RPC family, so this value needed zero new wire surface.

The hard constraint that shaped this: `settings.section` (the slot the Personalization page occupies) is declared `scope: 'root'` in `packages/client/ui-settings/src/client/contract/slots.ts` — there is no per-session variant, so a global Settings page structurally cannot address "the current conversation." Given that, and given the repo's flat requirement that a value reaching a model request must be reconstructable from the session log (not from a mutable external settings file), the design splits selection from provenance:

- The user's choice is an ordinary settings write (`ctx.settingsScope.bind()` from the browser, `settings.mutate` on the wire) — a global preference, exactly like `ui-theme`'s appearance row.
- `resolveSessionPersonality(session)` (`packages/context/personalization/src/session.ts`) is a **pure** function over `session.events`, scanning backward for the last `personalization/personality` event, defaulting to `pragmatic` when none exists — mirroring `resolveSessionPreset` in `packages/preset/agent-presets/src/session.ts` exactly.
- An `agent/session-start` listener seeds one event into a session's own log the first time it starts under a non-default personality (`hasLoggedPersonality` guards against re-seeding an already-logged session). A session that already logged one keeps it even after the global preference later changes — verified directly against a real `AgentLoop`-driven agent across two turns in `packages/context/personalization/tests/personalization.spec.ts`. The default is deliberately never logged: a session with no event already resolves to `pragmatic`, so seeding it would only be a no-op write.

Prompt integration reuses `ctx.systemPrompt.section()` directly (order `10`, chosen to sit just after `deployment:persona` at order `0` and well before tool guidance at `100`–`199`) with a dynamic `text: context => ...` function, exactly the pattern `AgentLoop`'s own prompt variables use for per-session values — no new prompt pipeline. `none` resolves to the empty string, which `renderPrompt`'s existing empty-section filter drops.

### Icon fix

`SettingsRoot.tsx`'s `navIcon(id)` mapped `'plugins'` to `IconPersonalizationOutline16` — a placeholder predating this feature, since `IconCordisPluginOutline14` (the correct plugin glyph) already existed unused. Adding `personalization -> IconPersonalizationOutline16` required also fixing `plugins -> IconCordisPluginOutline14` in the same edit.

### Memory: no engine, so no feature

The Memory area renders one static "unavailable" line with no toggle, no store, and no RPC call. Inventing a settings-backed toggle for a capability that does not exist would misrepresent what the deployment can do.

## Alternatives considered

- **Route custom instructions through `ctx.settings.register`** — rejected: that seam assumes a schema-validated section and an in-memory revision counter tied to a live registration; a raw text file with a content-hash revision needs neither, and forcing it through would require inventing a fake schema.
- **Give the personality picker a session-scoped write path** (e.g., a new `sessionId`-carrying RPC, mirroring `agentPreset.select`) — rejected: `settings.section` is hard-coded `scope: 'root'` at the type level, so no owner props ever carry a session id into this page; adding one would mean widening the slot contract for a single feature, which the client architecture explicitly reserves for slot-level decisions, not per-registrant workarounds.
- **Always append a `personalization/personality` event at every session start**, even for the default — rejected: pure log bloat with no resolution difference, since the resolver's own fallback already produces `pragmatic`.
- **A settings-backed Memory toggle "for future readiness"** — rejected outright: no engine exists to configure, and a working-looking control over nothing is worse than an honest unavailable line.

## Consequences

Custom instructions are durable, byte-capped, lock-safe, and loopback-only. The RPC writes the document that the [agent-instructions loader](../../../../packages/context/agent-instructions/README.md#state-and-refresh) reconciles before requests. A save can therefore update an existing chat at its next request without a filesystem tool call. Updates append replacement guidance to durable history; the editor never changes system-role authority.

Personality changes take effect for sessions started after the change, never retroactively for a session already running — a deliberate consequence of the session-log-is-authoritative design, not an oversight. Any composition with an effective `complete: true` prompt section (the shipped `minimal` preset) drops the personality section along with every other non-persona section, a pre-existing `SystemPrompt.assemble()` behavior this feature does not change but does newly depend on being aware of.

A prior `step/start` prevents seeding a new personality during resume, even when the original tone was implicit `pragmatic`. Absence of a personality event in a used chat is evidence for that default, not permission to adopt a later preference. Blank sessions remain eligible to adopt the current default without adding a redundant event for `pragmatic`.

## Testing

- The real Loader snapshot in `apps/cli/tests/personalization.snapshot.ts` checks first use, unchanged turns, replacement, and clearing through the settings RPC and model request history. Browser snapshots cover collapsed entry, Save-only tone writes, and instructions drafts across pending writes and section switches.

- `packages/host/apiproxy/tests/api-proxy-config.spec.ts`: real-`$HYDRA_HOME` round-trip (empty-document read, write, stale-revision conflict, correct-revision success, oversized-content rejection, file/dir permission bits on POSIX).
- `packages/client/connection/tests/node-half.host.spec.ts`: both RPCs pinned to loopback even against a declared trusted LAN authority, over real HTTP.
- `packages/context/personalization/tests/personalization.spec.ts`: real `AgentLoop`-driven agents — default/friendly/none prompt text, session-start seeding, and a resumed-in-place agent keeping its own logged personality after the global preference changes mid-conversation.
- `packages/client/ui-settings-personalization/tests/`: the custom-instructions controller's conflict/error/dispose paths, real slot registration and RPC routing (`apply.client.spec.ts`), and component-level save-gating/conflict/personality-selector behavior.
