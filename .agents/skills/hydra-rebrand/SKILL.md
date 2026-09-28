---
name: hydra-rebrand
description: Update Hydra harness product copy, browser labels, logos, favicons, and desktop identity in this repository. Use the known owner paths and focused residue checks; keep external provider names and upstream attribution accurate.
---

# Hydra harness Rebrand

Work from this repository's Git root. Preserve the dirty worktree. Read root `AGENTS.md`, applicable directory instructions, and [the brand map](references/dsh-brand-map.md).

1. Identify the requested surfaces and read their owners in the map.
2. Update owners, their tests, current docs, and generated derivatives together. Generate artwork from the supplied source; do not redraw it.
3. Run the focused tests, rebuild affected application artifacts, and verify the assembled UI.
4. Search for the previous display names in current source and docs; classify remaining matches by owner.

DeepSeek names identify the external LLM and search provider. Preserve upstream URLs, third-party attribution, LICENSE copyright, and frozen historical records. Package names use `@hydraharness`. The CLI, `$HYDRA_HOME` / `~/.hydra`, `HYDRA_*` variables, `hydra` package.json section, and browser destination `hydra` are the product's technical identifiers. The controlled PTY prompt is `hh>`. Product wire identity uses `hydra-harness`. SHA, UUID, and model call ids are not rewritten.
