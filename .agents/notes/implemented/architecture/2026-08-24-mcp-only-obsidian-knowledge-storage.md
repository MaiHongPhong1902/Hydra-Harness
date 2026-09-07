# Agent Note: MCP-only Obsidian knowledge storage

Status: implemented

## Problem

Website knowledge had two production storage paths: Obsidian MCP reads and direct filesystem fallback/write access. That split made the configured vault path part of user settings, gave the agent different evidence provenance for the same request, and could return stale filesystem knowledge after Obsidian's live index or open vault changed.

## Decision

`obsidian-knowledge` uses Obsidian Local REST API's built-in MCP server as its only production knowledge store. `ObsidianKnowledgeSettings` contains only the optional Browser-capture `targetDomain`; the composition-only `mcpUrl` defaults to the local loopback endpoint, and `OBSIDIAN_API_KEY` remains a Hydra credential. User settings contain no vault path, MCP URL, or token. Generic recall, exact reads, and approved saves do not require a target domain.

The plugin builds its graph over MCP `search_simple`, `vault_read`, and `vault_write`. Each operation reads `Hydra Website Knowledge/Hydra MCP Vault Identity.md` through MCP first. Search and exact-note reads fail closed when the credential, endpoint, marker, authentication, protocol, or required note is unavailable; the model-facing tools do not fall back to filesystem discovery and the testcase skill reports `Unresolved`.

`obsidian_knowledge_save_approved` remains the sole model-facing write path. The host asks for explicit approval of the exact call before it commits staged Browser observations or approved content. MCP writes validate logical graph paths, refuse to overwrite the identity marker, and read exact content back after `vault_write`. Page, control, action, and approved knowledge writes all use that path.

The plugin exposes bounded graph-memory tools in every composition and adds domain-gated Browser evidence only when configured. Raw Obsidian MCP tools are not exposed to the model. Portal and Back Office entrypoint URLs live in user-approved Obsidian notes; the configured domain is the only navigation setting. [Graph-linked contextual recall](../feature/2026-08-25-obsidian-graph-memory-recall.md) owns the retrieval bounds and package rename.

## Alternatives considered

**Keep the bounded local fallback.** Rejected because a fallback can silently answer from a different vault state than Obsidian MCP and defeats the provenance boundary required for testcase decisions.

**Mount a generic Obsidian MCP client.** Rejected because it would expose vault mutation, delete, move, and command tools outside the plugin's target-domain and explicit-approval controls.

**Write through MCP without readback.** Rejected because an acknowledgement alone cannot prove the exact approved Markdown reached the configured vault.

## Consequences

The user must keep the local Obsidian MCP server available and configure `OBSIDIAN_API_KEY`; otherwise knowledge-dependent requests resolve explicitly as unavailable rather than from a second source. Settings remain portable; the optional website domain adds Browser capture while Obsidian owns vault selection and approved application routes.

The local filesystem graph adapter remains isolated test support. It is not wired into the plugin or user configuration. The MCP service performs one connection per operation, which favors credential isolation and simple lifecycle handling over batching throughput.

## Testing

An in-process Streamable HTTP MCP fixture verifies marker reads, bounded search ranking, complete exact-note reads, missing-note semantics, rejected authentication, unavailable transport, protected marker writes, and exact write readback. Plugin integration tests run the same MCP boundary for approval-gated Browser graph commits and source lookup. Host TypeScript compilation, host bundling, and focused browser tests cover the assembled plugins.
