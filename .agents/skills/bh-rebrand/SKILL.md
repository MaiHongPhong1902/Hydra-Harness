---
name: bh-rebrand
description: Rebrand the Bosch Harness and WorkON desktop checkout at C:\Users\map7hc\Desktop\DSH\deepseek-harness using its known brand-owner paths and focused residue searches. Use for changes to WorkON, Bosch Harness or BH, DeepSeek provider/model display, BHAgent browser copy, product copy and titles, logos, favicon, or theme branding in this project; not for other repositories or standalone asset generation.
---

# BH Rebrand

Work only in `C:\Users\map7hc\Desktop\DSH\deepseek-harness`; its parent `DSH` is not the Git repository. Preserve the dirty worktree and never create or switch branches unless asked.

Read the root `AGENTS.md`, `BRAND_GUIDELINES.md`, and [references/dsh-brand-map.md](references/dsh-brand-map.md). Follow any narrower `AGENTS.md` for files being changed. Do not explore the full implementation first.

## Use the fast path

1. Confirm the Git root and inspect `git status --short`. Run the reference's cheap anchor check.
2. Classify the request into only the applicable lanes: desktop identity, Web/PWA identity, visual identity, product copy, or DeepSeek provider display.
3. Read the listed owner files for those lanes. Use the focused search commands to enumerate derivatives; open only matching files that are owned by the requested surface.
4. State a mini map before editing: `source -> target`, selected lanes, visual/copy traits supplied or observed, and technical identifiers to preserve. Ask only if the target or selected layer is genuinely ambiguous.
5. Edit owners first, then their tests, fixtures, snapshots, and current docs. Never run a blind repository-wide replacement.
6. Run the lane-specific focused checks, rebuild affected client artifacts before UI verification, and finish with a residue search. Explain each remaining legacy occurrence by category instead of reading every match.

Default to display-only rebranding. Keep DeepSeek provider/API identifiers, BH package and CLI identifiers, slot names, CSS token prefixes, legal text, third-party attribution, and historical records unchanged unless the user explicitly requests a technical migration.

For provider work, keep the browser-owned `BHAgent` actor and lowercase `bhagent` destination unless the user also requests browser branding. Search the contiguous token only; a separator-tolerant pattern such as `BH[ _-]*Agent` also matches technical `bh-agent` package names.

If an anchor moved, locate its replacement with `rg --files` or `rg -l` and continue from the smallest owner; do not fall back to reading the whole repository. Report the stale entry so this skill can be updated later.
