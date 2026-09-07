# Agent Note: Obsidian graph memory with contextual recall

Status: implemented

## Problem

The website-scoped Obsidian package required a configured domain even for ordinary knowledge lookup. Search returned independent excerpts, so a feature note could identify a relevant area without exposing its linked testcase paths. Increasing excerpt size or reading every linked note would add unrelated bodies to the conversation and spend tokens before the model selected evidence.

## Decision

Rename the pre-release package, Loader id, settings namespace, prompt section, public types, and tools from the website-specific vocabulary to `obsidian-knowledge`. Keep the physical `Hydra Website Knowledge/` vault root unchanged so existing notes and identity-marker configuration remain valid. Do not retain aliases for the unreleased names.

Generic `obsidian_knowledge_recall`, `obsidian_knowledge_read`, and approval-gated save work without `targetDomain`. Configuring `targetDomain` adds the existing exact-host Browser observation, navigation, and live-evidence policy; it does not gate graph memory.

Recall combines Obsidian `search_simple` with local contextual ranking and explicit wikilink expansion. It returns at most six matches, exact-reads only the strongest three seed notes to create focused excerpts of at most 320 characters, and returns at most 32 one-hop related paths without their bodies. Typed UAT feature and testcase notes receive evidence-aware ranking. The model selects match or related paths and reads complete notes in one existing 32-path, 64 KiB batch before relying on source fields.

This is graph-semantic retrieval through authored titles, note types, phrases, and relationships. It deliberately does not claim embedding similarity.

## Alternatives considered

**Add an embedding model and vector database.** Rejected until measured recall misses justify another credential or model, persistent index lifecycle, dependency, migration, and synchronization path.

**Return every linked note body during recall.** Rejected because a feature can link many testcases and most are irrelevant to one intent. Path-only expansion lets the model choose one exact batch.

**Rename the physical vault root.** Rejected because it would require a data migration and invalidate existing wikilinks without improving the package boundary.

**Traverse the complete graph recursively.** Rejected because one-hop authored links cover the current feature-to-testcase shape and keep latency and output bounded. A narrower second recall remains available.

## Consequences

Obsidian becomes a general memory capability while preserving optional Browser capture. Recall carries richer context with smaller output, but semantic quality depends on note titles, frontmatter, text, and explicit wikilinks. Notes without useful links still rely on lexical MCP search. A real embedding index remains deferred until retrieval misses are measured.

The rename is intentionally breaking before release: compositions and settings must use `obsidian-knowledge`, and model calls must use the `obsidian_knowledge_*` tools. Existing vault data needs no move.

## Testing

Focused graph tests verify that one feature returns all 15 linked testcase paths without returning their bodies, excerpts stay bounded, and generic recall and exact reads work with no website domain. Existing MCP, path-containment, Browser-domain, navigation, approval, and write-readback tests continue to cover the unchanged safety boundaries.
