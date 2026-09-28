# @hydraharness/harness-client-connection

`ctx.connection` owns the browser API client, loopback classification, connection generation, and the single-consumer Host/event downlink loops. The served Web app uses HTTP and WebSocket transport; a shell can supply `globalThis.__HYDRA_TRANSPORT__` with `createApiClient`, `fetch`, and optional `loadBundle` instead.

The Host owns the `/api` route and applies the loopback fence before a registered Typert Remote or API Proxy handles a request. Plugin inventory management is loopback-only: loader enablement, OpenAI/Codex marketplace-source changes, imported-plugin lifecycle, imported MCP-server enablement, and hook trust all expose installed code or mutate local configuration. A configured trusted host can invoke other application methods but cannot bypass this fence.

Authorization methods are loopback-only as well: account inventories reveal provider identities, and begin/answer/logout can start an interactive login, carry its answer, or mutate the provider account pool. The connection keeps these methods behind the same local caller check while ordinary model and session reads remain available to a configured trusted host.

## Model Experience

None, as this transport package neither assembles model input nor registers a model-facing capability.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Local-only plugin management** — remote clients cannot manage marketplace sources or imported bundles until an authenticated authority model exists.
