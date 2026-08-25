# Agent Note: Skill catalog hot refresh

Status: implemented

## Problem

Skill summaries are model routing input, but local skills can appear, disappear, or be renamed after a session starts. IDEs, Git operations, shell commands, and other processes can all mutate `.agents/skills` without going through the harness filesystem tools. A startup-only catalog leaves the model unaware of new skills and able to call deleted names. Treating every instruction-body edit as a catalog revision would instead couple progressive loading to unnecessary prompt churn.

Filesystem updates are also non-atomic from the observer's perspective. An editor or Git operation may briefly remove a file, a watched root may not exist at startup, and discovery may fail transiently. Publishing those intermediate observations as authoritative empty catalogs would be worse than retaining the last complete view.

## Decision

The skill capability separates catalog membership from instruction-body loading. `ctx.skills.snapshot()` returns summaries plus a completeness bit. `ctx.skills.registerProvider(factory)` gives the synchronous factory one registration-scoped `{ signal, invalidate }` control: `invalidate()` dirties only that exact active registration and discards completed catalog caches, while the signal aborts when registration fails or is disposed. Provider arrays are complete-discovery shorthand; an explicit incomplete observation can retain readable candidates for direct loads without becoming cacheable or authoritative for model-facing consumers. A provider or runtime generation change during discovery retries once; if the retry is also superseded, the latest candidates return as an incomplete, uncached observation. A late invalidation after disposal or replacement is a no-op because the capability has been revoked.

`@bosch/bh-skill-filesystem` directly depends on Chokidar and observes catalog-relevant host paths. Existing roots watch direct skill bundle directories, flat Markdown entries, and direct `SKILL.md` entry files. Additions, removals, and directory changes invalidate membership; file changes support frontmatter `name` and `description` refresh. Resource files below a bundle are ignored. Events in one microtask batch coalesce to one invalidation. Project watchers use a bounded least-recently-observed set.

A missing root is followed from its nearest existing ancestor one absent segment at a time with `fs.watchFile`, then handed to Chokidar once the real root exists. Before scanning, each discovery re-probes the retained root/ancestor mode. That independent probe re-establishes ancestor observation after deletion even when child removals invalidate and publish an authoritative empty catalog before, or without, a root `unlinkDir` event. Chokidar configuration exposes native-versus-polling mode, write stability, polling interval, symlink following, and project watcher capacity. First-party `write` and `edit` tool observations synchronously invalidate a relevant provider, so the next model step sees its own mutation without waiting for host delivery. Watch startup/runtime failures are logged and retried; discovery still returns readable candidates for direct loads but reports an incomplete observation. Teardown closes watchers and ignores late callbacks.

`@bosch/bh-tool-skill` no longer publishes registry snapshots into model history. The [bounded skill routing decision](../architecture/2026-08-25-bounded-skill-routing.md) replaces full-roster publication with an on-demand, size-capped search result and exact loading. Filesystem and runtime invalidation still make the next `skill_search`, `skill`, user gesture, or human-facing directory read observe current metadata. Historical sourced `skill-catalog` messages remain readable replay records; the generic transcript catalog renderer keeps compatibility but is not a current producer contract.

The TUI consumes the same invalidation as presentation state, not session history. `skills/change` carries no diff; the TUI refetches `snapshot()` for the active session cwd, applies only the latest complete result, and retains the previous commands across incomplete observations. A complete empty result clears stale completions. Because pi-tui closes autocomplete when its provider is replaced, a catalog that arrives while the user is typing a slash-command name also triggers a suggestion-only re-query of the current draft.

Instruction bodies keep progressive disclosure. Every `skill(name)` call asks the provider to reread and parse the current file; there is no body cache, hash, revision, or proactive notification. Previously logged tool results remain unchanged. If the loaded frontmatter name no longer matches the selected candidate, the registry rejects the stale name and invalidates that provider so later discovery observes the new name.

## Verification

Registry tests pin registration-scoped invalidation, revocation, signal abort, contained observer failures, incomplete candidates, bounded generation retries, and stale-name rejection. Local-provider tests cover bundle and flat-file creation, removal, rename, root creation/deletion/recreation including an unobserved root `unlinkDir`, description changes, body-only edits, first-party observation, symlinks, polling options, persistent watcher failures with loadable candidates, event coalescing, bounded projects, teardown, and transient reads. Search tests pin current metadata after invalidation, incomplete-state reporting, scoped visibility, model policy, and zero body loads. TUI tests pin last-complete retention, authoritative empty removal, latest-wins refresh, teardown, and the already-open slash-draft race; a real Loader/PTY smoke adds a local skill after startup and observes its completion without restarting. An assembled agent-spine test creates a project skill through model-facing filesystem tools, finds it on the next search, and loads its current body with the real `skill` tool.

## Alternatives considered

- **Put the live catalog in World State** — rejected because provider metadata is registry state and current model discovery is an explicit tool result. Historical published catalogs remain ordinary session history rather than gaining a second mutable state plane.
- **Rely only on `fs/observed`** — rejected because IDEs, Git, shell commands, and external processes do not cross that seam. The event remains a latency fast path for first-party tools, while host watching supplies coverage.
- **Hash or version every `SKILL.md` body** — rejected because the model initially sees only names and descriptions, and the provider already rereads the body on each tool call. Body revisions would create catalog traffic without changing routing and would not justify rewriting historical tool results.
- **Watch every bundle resource** — rejected because references, scripts, and assets are loaded on demand and do not affect the category list. Broad recursive watching would add invalidations, descriptor pressure, and platform variability without improving routing.
- **Treat partial or failed discovery as authoritative absence** — rejected because a transient read failure is not evidence of deletion. The completeness bit is exposed on bounded search results and lets human-facing consumers retain their last complete directory.
- **Keep `invalidateProvider(provider)` public** — rejected because it exposes a registry mutation method and makes callers resupply an identity the registry already owns. The factory-issued closure binds invalidation to one registration and becomes inert on disposal, so observers need neither registry access nor provider identity.
- **Extract a generic Cordis file-watching service now** — deferred until another consumer establishes the reusable service contract. The local provider marks its Chokidar and missing-root observation boundary for that extraction; skill-path filtering and the call to the provider's invalidation closure remain skill-specific.

## Consequences

- New, deleted, and renamed local skills become visible on the next discovery or exact lookup without restarting the agent, including when the skills root did not exist at startup.
- The TUI's `/skill:` completions converge on the same complete catalog without blocking each keystroke on discovery; an open slash-name draft refreshes when the catalog arrives.
- New sessions emit no whole-list catalog messages. Each model search is an ordinary bounded tool result; prior results remain historical facts rather than being rewritten after invalidation.
- Body-only edits produce no proactive message. A subsequent exact load sees current content, while prior tool results remain an accurate record of what the model previously loaded.
- Missing-root polling and Chokidar add one maintained runtime dependency, host watcher resources, bounded detection latency, and deployment tunables. The bounded project set and teardown contract contain those costs.
- Remote or future mutable providers retain their own registration-scoped invalidation closure and call it from their observation mechanism; the registry does not impose a universal watcher or TTL.
