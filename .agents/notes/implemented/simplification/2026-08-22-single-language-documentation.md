# Agent Note: One English documentation corpus, no translation pairing

Status: implemented

## Problem

The repository carried every document twice: English `foo.md`, Chinese `foo.zh.md`, and a `foo.i18n.yaml` sidecar recording both blob hashes as of the last confirmed-consistent state. A gate (`verify-translation-pairing`) proved completeness and consistency, a Git merge driver resolved conflicted sidecars, a translation-prompt snapshot pinned the model-visible system message, and a briefing generator recovered each side's last-confirmed text so re-translation stayed minimal. The doc site published two locales from that layout: `.zh.md` at bare routes and `.md` under `/en/`.

That mechanism was sound and it worked. What it cost was paid on every documentation edit, and the readership it served was the original bilingual team. The rebrand to Bosch Harness renamed identifiers across 5132 files and left 754 pairs inconsistent — the Chinese sides still read `dsh` and `@deepseek-ai/` — which put the true price in one number: keeping the second language meant reviewing and re-recording 754 pairs before any unrelated work could land, and repeating a share of that on every subsequent rename. The corpus has one audience now and it reads English.

## Decision

The Chinese corpus and the whole pairing mechanism are gone. Only the frozen Agent Note archive keeps its `.zh.md`/`.i18n.yaml` files, because sealed history is never edited.

- **Deleted sources.** All 1004 `.zh.md` files outside `.agents/notes/archived/`, every `.i18n.yaml` sidecar outside the archive, and `docs/i18n/` (the pairing contract, translation rules, terminology, prompt, and style samples).
- **Deleted gates and tooling.** `verify-translation-pairing`, `verify-translation-prompt`, `resolve-translation-pairing-conflicts`, the `translation-pairing*` and `translation-prompt*` modules, `translation-brief`, `translation-links`, `scripts/translation-pairing.manifest.json`, and the recorded translation-prompt snapshot fixture. The `bh-translation-pairing` Git merge driver is no longer configured by `scripts/install-lefthook.mjs`, and `lefthook.yml` runs no pairing job in `pre-commit` or `pre-merge-commit`. The `bh-translate-docs` skill is deleted.
- **One doc-site locale.** [website/docs.ts](../../../../website/docs.ts) declares `DocsPage` with a single `source`/`route` pair; `DocsLocale`, `contentLocale`, `localized()`, `mirroredPages()`, and `pairedPages()` are gone. [website/.vitepress/config.ts](../../../../website/.vitepress/config.ts) sets `lang: 'en-US'` and one `themeConfig` in place of the `root`/`en` locale split, so every page publishes at a bare route. [scripts/project-doc-site.ts](../../../../scripts/project-doc-site.ts) drops locale-aware link rewriting, counterpart resolution, and the language-switcher splice; `llms.txt` lists one collection sequence.
- **Sidebar collections renamed.** `zh-guide`/`zh-develop`/`en-docs` are now `guide`/`develop`/`reference`, and section placement moved from `sectionOrder` in the VitePress config into the `sections` list in `website/docs.ts`.
- **Prose contracts follow.** `AGENTS.md`, [docs/AGENTS.md](../../../../docs/AGENTS.md), [docs/development.md](../../../../docs/development.md), [docs/rescope.md](../../../../docs/rescope.md), [.agents/notes/README.md](../../README.md), and the `bh-doc-standards`, `bh-doc-site-sync`, `bh-code-review`, `bh-prose-standard`, `bh-trim-cot-leakage`, `bh-find-simplifications`, and `bh-archive-agent-notes` skills no longer describe pairs, counterparts, or locale routes.

Seven implemented Agent Notes described only this mechanism and are consolidated here under the removal rule in [the Agent Note rules](../../README.md#archiving-and-deletion): the pairing gate, the translation-prompt v4 contract, briefed minimal translation updates, lightweight routine translation, automatic pairing merges, Chinese contract terminology, and localized bilingual links. Their motivation, the alternatives they beat, and what the removal gives up are recorded below.

## What the pairing design got right, and why it still went

The original design chose paired sibling files over four alternatives, and each rejection still holds for anyone rebuilding a bilingual corpus here:

- **Locale directories (`docs/en/`, `docs/zh/`)** — moving every English file churns every cross-reference, and `verify-md-links`/`verify-doc-refs` would need path-mapping logic instead of working unchanged.
- **A separate translation repository** — right for a docs product with its own release train, but it puts the translation outside this repo's gates.
- **Interleaved bilingual files** — doubles every diff and makes partial inconsistency invisible.
- **Commit-hash records (MDN `l10n.sourceCommit`)** — a same-PR edit has no commit hash yet, so it cannot express "consistent as of the state this PR introduces". Blob hashes can, and are computable from file content with no history lookup.

None of those is why the mechanism was removed. It was removed because the corpus no longer has Chinese readers, so the per-edit cost buys nothing.

## Alternatives considered

**Keep the pairing gate and re-record the 754 inconsistent pairs.** Rejected: it is a large review with no reader on the other end, and the same bill arrives at the next rename. Restoring the Chinese sides was the first thing tried — the corpus was intact and no pair was missing — which is precisely what made the size of the recurring cost measurable.

**Keep the Chinese files but delete only the gate.** Rejected: an unchecked translation is the failure mode the gate existed to prevent. One side moves, the other silently lies, and now nothing notices. Half the mechanism is worse than either whole.

**Keep the two-locale site with English on both routes.** Rejected: `mirroredPages()` already expressed exactly that fallback, and carrying a locale dimension whose two values resolve to the same content is machinery that describes a distinction the content does not make.

**Machine-translate on the site build instead of committing translations.** Rejected: it moves the corpus outside review, and unreviewed translation of contract prose — preconditions, invariants, failure modes — is how a translated document becomes wrong in a way no gate can see.

## Consequences

- Every documentation edit is now one file. The doc-sync obligation stays; the counterpart obligation is gone.
- Chinese readers lose the corpus. Reintroducing it means restoring the `.zh.md` layout, the sidecar records, and a consistency gate from git history — the design is recorded above and the deleted implementations are recoverable at the commit that removed them.
- The frozen archive is now the only place in the tree carrying `.zh.md` and `.i18n.yaml` files. It stays sealed and is not authority for current practice.
- **Archiving a new Agent Note is blocked until [`verify-archived-agent-notes`](../../../../scripts/verify-archived-agent-notes.ts) is updated.** It still requires a complete `.md`/`.zh.md`/`.i18n.yaml` triplet, and notes written after this change have no Chinese side. The verifier was deliberately left untouched so the existing seals stay provable; the triplet requirement must become "English-only for entries sealed after this change" before the next archival. [.agents/notes/README.md](../../README.md) and the [`bh-archive-agent-notes`](../../../skills/bh-archive-agent-notes/SKILL.md) skill both state this gap.
- `docs/i18n/README.md#the-pairing-contract` was a link target for several documents. Every inbound reference is repaired; `verify-md-links` and `verify-doc-refs` prove no dangling target remains.

## Testing

[`project-doc-site.spec.ts`](../../../../scripts/project-doc-site.spec.ts) covers the single-locale projection: route and alias resolution, README subsystem indexing, the full 43-page subsystem reference, the Cordis core API section, raw-Markdown twins, `llms.txt` ordering, and an undeclared sidebar section rejected by `sectionSpec()`. `pnpm run doc-sync` regenerates every catalog against the reduced corpus, and `verify-md-links`/`verify-doc-refs` prove the deleted `docs/i18n/` tree has no surviving inbound link.
