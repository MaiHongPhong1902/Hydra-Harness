# @hydra/harness-mcp-registry

`McpServerRegistry` (`ctx.mcpServers`) owns the user's own MCP server records. The records live in the `mcp-servers` settings namespace, so one added from a configuration surface is written to `$HYDRA_HOME/settings.yaml` and mounts again on the next start; one added by hand-editing that document mounts without a restart. Each enabled record is mounted as an `@hydra/harness-mcp-client` fiber whose `serverName` is the record name, which makes its tools `mcp__<name>__<tool>`.

## Service API

`list()` projects every stored record with its live status and currently registered tool names. `define(request)` stores one complete definition and converges the mounted set: `mode: 'create'` requires an unused name, and `mode: 'replace'` requires an existing record. These conditions are checked inside the serialized mutation chain, so concurrent creates cannot overwrite one another and an edit cannot recreate a removed record. `setEnabled({ name, enabled })` changes only the desired state. `remove(name)` deletes the record and unmounts it. Every mutation and every reconciliation runs on one serialized chain, so a write never observes a half-applied mount.

On replacement, omitted `enabled` and `toolCallTimeoutMs` retain their stored values. Omitted `env` and `headers` also retain stored values because both are secret positions that a redacted descriptor never carries. Other omitted optional fields clear the stored values.

## Stored records

`mcp-servers.servers` is an ordered list of at most 50 records. A record carries `name`, `transport` (`stdio` or `streamable-http`), both transports' fields, `toolCallTimeoutMs`, and `enabled` (default `false`, so a new record is inert until switched on). A stdio record requires `command` and may carry `args`, `env`, and `cwd`; a `streamable-http` record requires an absolute HTTP/HTTPS `url` and may carry `headers`. `name` must match `[A-Za-z0-9_-]{1,32}` and be unique across records — a section declaring one name twice is refused at the write, because which server served a tool would otherwise depend on mount order.

A stored record this registry cannot mount is reported with status `invalid` and the refusal reason instead of failing the process: a hand-edited document must not prevent every other server from starting. A record whose connection fails reports `failed` with the transport's summary; `mcp-client` keeps its own reconnect policy running underneath.

`mcp-servers/reconciled` is emitted after each reconciliation settles, carrying the projection. The package invariant checks the registry's one contract on that event: an accepted enabled record is live and a disabled one is not.

Server mounts belong to the registry's Host context and survive disposal of the API caller. Disabling or removing the record, or unloading the registry, disposes the connection and its registered tools.

## Model Experience

Indirectly, through `@hydra/harness-mcp-client`, which registers each mounted server's tools on `ctx.tools` under `mcp__<name>__<tool>`. This package decides which servers are mounted; it assembles no model input of its own.

#### KV Cache effect

Independent of this package's own operations, and consequential through them: mounting or unmounting a record changes the tool catalog of subsequent requests, which replaces the tool-definition prefix and invalidates reuse for sessions built before the change. Records are stable between edits, so an unchanged document leaves the prefix alone.

## Known Limitations and Deferred Work

- **No OAuth or bearer-token acquisition** — a remote record authenticates only through the static `headers` it stores, so a server requiring an interactive authorization flow cannot be declared here.
- **No per-record tool approval** — `defaultToolsApprovalMode` and per-tool overrides exist for imported plugin bundles (`@hydra/harness-plugin-runtime`) but not for these records; a mounted server's tools follow the process-wide approval policy.
