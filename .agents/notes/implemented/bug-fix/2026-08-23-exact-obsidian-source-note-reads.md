# Agent Note: Exact Obsidian source-note reads

Status: implemented

## Problem

`website_knowledge_search` returns bounded excerpts for discovery, while `website_knowledge_read` is deliberately tied to the current Browser page. An agent therefore had no supported way to read a persisted imported testcase after search found its path. Repeated searches amplified latency and let an absent excerpt fragment be mistaken for an empty workbook field.

## Decision

`obsidian-website-knowledge` exposes `website_knowledge_read_notes` beside the two existing read surfaces. It accepts exact extensionless paths returned by search and returns complete Markdown notes in first-occurrence request order. One call accepts at most 32 paths and 64 KiB total; it fails the entire batch for missing, invalid, non-file, out-of-root, or oversized input instead of returning partial or truncated evidence. Canonical path containment prevents a symlink or junction from escaping `BH Website Knowledge/`.

The read backend is owned by [Obsidian MCP as the knowledge read backend](../feature/2026-08-23-obsidian-mcp-knowledge-reads.md): live MCP reads preserve this exact-path contract, while the contained filesystem reader remains the unavailable-transport fallback.

The model prompt treats search excerpts only as path discovery, requires an exact note read before source fields support a claim, and fails closed when that read is unavailable. Current-page `website_knowledge_read` keeps its Browser precondition and separate live-evidence meaning.

## Alternatives considered

**Increase search excerpts or result count.** This still makes discovery output act as source data, grows every search result, and cannot guarantee that all workbook columns are present.

**Overload `website_knowledge_read` with optional paths.** This merges persisted source lookup with current Browser-page evidence and creates ambiguous input and output contracts.

**Let the agent use filesystem search and reads.** This bypasses the configured vault boundary, caused broad host scans in the observed failure, and makes tool availability rather than the knowledge plugin own source access.

## Consequences

A feature note and its linked testcase notes can be retrieved in two bounded calls without Browser startup or filesystem discovery. Large collections must be split into multiple exact batches, and any unreadable member remains visible as `Unresolved` instead of degrading into fabricated source values.
