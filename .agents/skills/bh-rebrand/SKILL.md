---
name: bh-rebrand
description: Update Hydra harness product copy, browser labels, logos, favicons, and desktop identity in this repository. Use the known owner paths and focused residue checks; keep external provider names and upstream attribution accurate.
---

# Hydra harness Rebrand

Work from this repository's Git root. Preserve the dirty worktree. Read root `AGENTS.md`, applicable directory instructions, and [the brand map](references/dsh-brand-map.md).

1. Identify the requested surfaces and read their owners in the map.
2. Update owners, their tests, current docs, and generated derivatives together. Generate artwork from the supplied source; do not redraw it.
3. Run the focused tests, rebuild affected application artifacts, and verify the assembled UI.
4. Search for the previous display names in current source and docs; classify remaining matches by owner.

DeepSeek names identify the external LLM and search provider. Preserve upstream URLs, third-party attribution, legal notices, and frozen historical records. Package names use `@hydra`; the `bh` executable, `BH_*` variables, persisted paths, browser destination `bhagent`, and wire identifiers remain technical names unless a migration explicitly includes them.
