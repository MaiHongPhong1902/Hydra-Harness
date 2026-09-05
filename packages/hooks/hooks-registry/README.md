# @bosch/bh-hooks-registry

`HookRecordRegistry` (`ctx.hookRecords`) owns the user's own hook records. The records live in the `hooks` settings namespace, so one added from a configuration surface is written to `$BH_HOME/settings.yaml` and mounts again on the next start; one added by hand-editing that document mounts without a restart. Each enabled record is mounted on its dialect's bridge — `@bosch/bh-hooks-claude-code` or `@bosch/bh-hooks-codex` — which owns the payloads, matcher semantics, and extension-point mapping.

## Service API

`list()` projects every stored record with its live status, the events its definitions cover, and how many command hooks they declare. `define(request)` stores one complete definition — replacing any record of the same name — and converges the mounted set. `setEnabled({ name, enabled })` changes only the desired state. `remove(name)` deletes the record, unmounts it, and deletes any document this registry materialized for it. Every mutation and every reconciliation runs on one serialized chain.

`define` replaces the named record wholesale: an omitted optional field clears the stored one. Nothing here is withheld from a read, so an omission is always a deliberate clear.

## Stored records

`hooks.records` is an ordered list of at most 50 records. A record carries `name` (`[A-Za-z0-9_-]{1,64}`, unique across records), `dialect` (`claude-code` or `codex`), exactly one document source, `defaultTimeoutMs`, and `enabled` (default `false`, so a new record is inert until switched on). `claude-code` records may also carry `pluginRoot` and `projectDir`, which the bridge substitutes into command strings.

The document source is either `configPath` — an absolute path to a hook document the harness reads as-is — or `config`, the definitions stored inline in the settings document as a bare event map or a `{ hooks: … }` wrapper. Inline definitions are capped at 256 KiB and materialized to `$BH_HOME/hooks/<name>.json` on every mount, because both bridges read one file path at load; editing the inline section is therefore enough to change what runs.

`define` parses the definitions with the record's own dialect parser before it persists, so a stored record can never be silently inert. At mount time the same parse decides the record's projection: a record whose document is missing, is not valid JSON, or declares nothing its dialect can run is reported with status `invalid` and the reason instead of failing the process — a hand-edited document must not stop every other record from mounting.

`hooks-registry/reconciled` is emitted after each reconciliation settles, carrying the projection. The package invariant checks the registry's one contract on that event: an accepted enabled record is live and a disabled one is not.

## Model Experience

Indirectly, through the bridge a record mounts. `@bosch/bh-hooks-claude-code` and `@bosch/bh-hooks-codex` own everything a hook injects into a request — `SessionStart` and `UserPromptSubmit` context, `PostToolUse` feedback, `Stop` continuation messages — and this package decides only which of their configurations are live. It assembles no model input of its own.

#### KV Cache effect

Independent of this package's own operations, and consequential through them: mounting a record makes its hooks able to inject context into later requests, which the bridges document. Mounting or unmounting between requests does not itself rewrite an existing prefix; a hook that injects a message appends to the conversation like any other message.

## Known Limitations and Deferred Work

- **Process-wide records only** — each bridge reads one document at load, so a record applies to every session in the process. Per-session or project-local hook discovery stays the bridges' own `TODO(per-session-hook-config)`.
- **No dialect conversion** — a record is mounted by the dialect it declares; the registry never translates a Claude Code document into Codex spelling or the reverse, and each dialect silently drops events the other supports.
