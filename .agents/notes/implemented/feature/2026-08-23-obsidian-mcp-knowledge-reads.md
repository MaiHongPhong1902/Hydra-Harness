# Agent Note: Obsidian MCP as the knowledge read backend

Status: implemented

> The filesystem-fallback and local-write portions of this decision are superseded by [MCP-only Obsidian knowledge storage](../architecture/2026-08-24-mcp-only-obsidian-knowledge-storage.md). This note remains authoritative for the narrow model-tool boundary, loopback-only endpoint, per-operation credential resolution, marker verification, and search ranking.

## Problem

The website knowledge plugin searched and read Markdown directly from disk, so BH did not benefit from Obsidian's live index and could not distinguish a live Obsidian result from a filesystem fallback. Mounting the generic MCP client would expose Obsidian's mutating vault and command tools without the knowledge plugin's domain and approval policy.

## Decision

`obsidian-website-knowledge` connects on demand to Obsidian Local REST API's Streamable HTTP MCP endpoint. Its existing `website_knowledge_search` and `website_knowledge_read_notes` tools call only `search_simple` and `vault_read`; raw MCP tools are not registered with the model. The endpoint is restricted to `127.0.0.1` and `/mcp/`, the bearer token is resolved per operation from BH credential reference `OBSIDIAN_API_KEY`, and exact content at `BH Website Knowledge/BH MCP Vault Identity.md` must match through the configured local vault and MCP before any knowledge operation runs.

A missing credential or a network-refused, unreachable, reset, or timed-out MCP connection permits the bounded local-vault readers to run. Rejected authentication, an incompatible protocol, a different vault marker, a valid empty result, malformed MCP result, tool failure, mismatched path, or oversized note fails closed and never falls back. MCP search reranks the complete valid hit set by exact phrase, term coverage, individual test-case evidence, and stable path before applying the eight-result cap, so unrelated step text cannot crowd exact feature cases out. Read results identify `obsidian-mcp` or `local-vault` as their backend. Exact-note limits and semantics remain owned by [Exact Obsidian source-note reads](../bug-fix/2026-08-23-exact-obsidian-source-note-reads.md).

Writes remain local and available only through `website_knowledge_save_approved`. A host `tools/pre-execute` decision requests approval for the exact call before staged Browser evidence or approved knowledge is committed; the model-provided approval literal is not authorization.

## Alternatives considered

**Mount the generic MCP client.** Rejected because it registers every remote Obsidian tool, including write, delete, move, and command execution, outside the knowledge plugin's narrow policy.

**Replace local reads completely.** Rejected because Obsidian may be closed during non-live analysis and the exact vault remains a useful bounded fallback.

**Route approved writes through MCP.** Rejected because the existing atomic local writer already owns path containment and provenance, while a second write path would expand the approval and failure surface.

## Consequences

BH gets native Obsidian search and exact reads without exposing remote mutation tools or adding startup latency. Obsidian and its Local REST API plugin must be running for the MCP backend; otherwise result provenance makes the local fallback explicit. Loopback HTTP protects the bearer token from remote hosts but is not encrypted on the local machine.

## Testing

An in-process Streamable HTTP MCP server verifies bearer authentication, matching vault identity, bounded search filtering, exact complete-note reads, missing-credential and connection fallback, and fail-closed rejected authentication, mismatched vault identity, and malformed responses. Plugin tests verify that rejected host approval writes neither staged nor approved knowledge.
