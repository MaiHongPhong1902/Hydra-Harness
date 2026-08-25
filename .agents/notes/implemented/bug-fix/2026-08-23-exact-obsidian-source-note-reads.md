# Agent Note: Exact Obsidian source-note reads

Status: implemented

## Problem

The former search tool returned bounded excerpts for discovery, while the Browser read was deliberately tied to the current page. An agent therefore had no supported way to read a persisted imported testcase after search found its path. Repeated searches amplified latency and let an absent excerpt fragment be mistaken for an empty workbook field.

## Decision

`obsidian-knowledge` exposes `obsidian_knowledge_read` beside contextual recall and current Browser evidence. It accepts exact extensionless paths returned by recall and returns complete Markdown notes in first-occurrence request order. One call accepts at most 32 paths and 64 KiB total; it fails the entire batch for missing, invalid, non-file, out-of-root, or oversized input instead of returning partial or truncated evidence. Canonical path containment prevents a symlink or junction from escaping `BH Website Knowledge/`.

The production read backend is owned by [Obsidian MCP as the knowledge read backend](../feature/2026-08-23-obsidian-mcp-knowledge-reads.md): live MCP reads preserve this exact-path contract and fail closed rather than discovering notes through the filesystem. The contained filesystem reader remains isolated test support.

The model prompt treats recall excerpts and graph edges only as path discovery, requires an exact note read before source fields support a claim, and fails closed when that read is unavailable. Current-page `obsidian_knowledge_read_browser` keeps its Browser precondition and separate live-evidence meaning. [Graph-linked contextual recall](../feature/2026-08-25-obsidian-graph-memory-recall.md) owns the bounded discovery step.

## Alternatives considered

**Increase search excerpts or result count.** This still makes discovery output act as source data, grows every search result, and cannot guarantee that all workbook columns are present.

**Overload `obsidian_knowledge_read_browser` with optional paths.** This merges persisted source lookup with current Browser-page evidence and creates ambiguous input and output contracts.

**Let the agent use filesystem search and reads.** This bypasses the configured vault boundary, caused broad host scans in the observed failure, and makes tool availability rather than the knowledge plugin own source access.

## Consequences

A feature note and its linked testcase notes can be retrieved in two bounded calls without Browser startup or filesystem discovery. Large collections must be split into multiple exact batches, and any unreadable member remains visible as `Unresolved` instead of degrading into fabricated source values.
