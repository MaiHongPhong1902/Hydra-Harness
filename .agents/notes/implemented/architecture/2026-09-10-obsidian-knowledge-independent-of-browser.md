# Agent Note: Obsidian knowledge is independent of Browser tooling

Status: implemented

## Problem

`@hydraharness/harness-obsidian-knowledge` had grown a second job: it observed every `browser_*` tool result, gated navigation to a configured `targetDomain`, denied bare-domain navigation, forced a live-verification turn, generated application-root URLs from note contents, and committed page/control/action notes as approved evidence. That coupled a knowledge-retrieval plugin to the browser seam's event stream and result shape, so the two could not be reasoned about or enabled separately: Obsidian's settings and approvals could block, steer, or write on behalf of browsing that had nothing to do with knowledge.

The coupling also ran one way only. `@hydraharness/harness-tool-browser` and `@hydraharness/harness-browser-electron` never referenced Obsidian; Obsidian reached into their results through `tools/pre-execute`, `tools/result`, `agent/pre-step`, and `agent/turn-stopping`. The dependency existed solely to serve the capture feature.

## Decision

The two plugins are independent. Obsidian knowledge lives in the [knowledge package group](../../../../packages/knowledge/README.md), with no Browser package dependency or TypeScript project reference; Browser tooling continues to operate through `tool-browser → browser-electron → PageController` with no knowledge of Obsidian. The Obsidian package name, profile entry, credentials, and vault paths stay unchanged.

Obsidian retains exactly three model-facing tools — `obsidian_knowledge_recall`, `obsidian_knowledge_read`, and `obsidian_knowledge_save_approved` — plus the host approval gate on the save tool, the MCP storage adapter, vault-identity verification, path containment, byte limits, and credential resolution. The save tool persists the approved title, content, and evidence; it no longer attaches browser observations.

Removed from Obsidian: the `BrowserKnowledgeRecorder`, the `obsidian_knowledge_read_browser` tool, the `targetDomain` composition and user-settings field with `hostnameOf`/`matchesTargetDomain`/`normalizeTargetDomain`, `navigationCandidates`, the `navigationCandidates` result field, the browser-navigation prompt rules, the live-verification detection and reminder, the URL-deny policies, and the page/control/action note writers in the graph. `Approved Knowledge` notes now live directly under `Hydra Website Knowledge/` instead of under a per-domain folder. The preload no longer imports `@hydraharness/harness-tool-browser`.

Website navigation limits are now decided by the existing browser policies alone. A settings document carrying the old `obsidian-knowledge.targetDomain` entry is ignored; no vault data moves and no migration runs, because the plugin never wrote outside the notes it generated.

## Alternatives considered

**Keep the capture feature behind a flag.** A flag would preserve the coupling the change exists to remove, and would leave Obsidian observing every browser result even when capture is off. The feature's value did not justify a permanent seam between two otherwise unrelated plugins.

**Move the capture feature into the browser package.** That would make browser tooling own vault writes and Obsidian note schemas — the same coupling mirrored, now pulling the browser seam toward a knowledge system it does not otherwise need.

**Keep targeting as a browser policy and drop only the note writers.** The deny rules and forced verification turn still changed browser behavior based on Obsidian settings, so the two could not be toggled independently; that was the property being fixed.

## Consequences

Enabling, disabling, misconfiguring, or losing the Obsidian MCP connection no longer affects browser control: no URL is blocked, no extra turn is forced, and no vault write happens as a side effect of browsing. Conversely, Obsidian recall, read, and approved saves work with no browser mounted at all. Both directions are covered by [Obsidian knowledge tests](../../../../packages/knowledge/obsidian-knowledge/tests/obsidian-knowledge.spec.ts), including a browser tool running unmodified with Obsidian mounted and no per-domain note directories appearing.

`BrowserToolValue.unchanged` — added to the browser result shape for compact-snapshot reuse — now has no consumer outside `tool-browser` itself; it remains a model-facing token-saving field. The removed `targetDomain` gate means a deployment that relied on Obsidian to constrain live verification must rely on the browser's own policy surface instead.
