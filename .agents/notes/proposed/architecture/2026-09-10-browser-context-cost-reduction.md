# Agent Note: Browser context-cost reduction phases

Status: proposed

## Problem

A long browsing run pays for the page on every step. Each `browser_*` call returns a trailing snapshot — the full element list bounded by `maxStateChars` (default 16,000) or, after an ordinary action, a ranked compact list bounded near 4,000 characters. Hydra already trims that cost: only visible viewport controls are listed, compact results rank newly appeared and typical form controls first, `browser_find`, named click/type/select, `browser_fill`, and trailing state reads reduce round-trips, and two model-visible reductions have shipped — an ignored-node filter and an `unchanged` reuse flag ([browser ignored-node filtering](../../implemented/feature/2026-09-10-browser-ignored-node-filtering.md)).

What remains is measurement-led structure: the repository now has an offline six-scenario benchmark with committed baseline/current measurements, and ordinary actions can return a per-tab structural diff. The projection still follows PageController's indexed snapshot contract, trajectory pruning remains separate work, and snapshot offload or conditional vision still lack evidence that they justify their lifecycle cost. Any further change risks trading a real control or a valid index for tokens without evidence it helped.

The reduction must preserve the element indices, `tabId`, and `BrowserState` contract; the full session log and replay; current security behavior; action accuracy and the fallback for pages without usable accessibility signals.

## Proposal

Seven phases, executed in this order: baseline and telemetry (retrofit); prefix stability and cache verification; snapshot projection and downsampling; per-tab state diff; browser-aware trajectory pruning; snapshot offload; conditional vision. Each ships as one small PR with regression tests and a keyless snapshot; every model-visible change updates `docs/subsystems/browser.md`, the tool catalog, and the owning Agent Note.

The standalone specification is retired; this note carries the rationale, scope corrections, alternatives, remaining phases, and acceptance criteria. Shipped behavior and measurements live in the [browser subsystem reference](../../../../docs/subsystems/browser.md) and the [browser benchmark](../../../../examples/acp-agent/browser-bench), and the removal decision is recorded in the [spec removal note](../../implemented/simplification/2026-09-27-remove-browser-context-cost-spec.md).

### Scope corrections

Three corrections were confirmed against the vendored `PageController` and shrink or change what a phase is allowed to promise.

- `aria-hidden="true"` and its subtree are already dropped upstream, inside the DOM-tree builder (`.../page-controller/src/dom/dom_tree/index.js`, line 1496), so that removal is not work. What remains is `role=presentation`, `role=none`, `inert`, and non-indexed lines with no visible text.
- Every ignored-node marker must be matched as an attribute *name*, never as a raw substring. The shipped filter had two substring defects where a value such as `data-state=inert` or `href=/docs?role=none` deleted a control the model needed; any new removal needs the same name-based precision.
- Native `disabled` controls are excluded from the indexed list by `isInteractiveElement` itself, so `disabled` reaches the model only through `aria-disabled` or a custom interactive element. The plan promises partial disabled coverage, not full; the native case is tracked as an open question, not as work in a phase.

The size target is re-set from the Phase 1 baseline. The first draft committed to "at least 30%", which cannot be verified while the benchmark does not exist and the vendor already removes part of the markup.

### What the sequencing changes

The first draft ran baseline, then projection, then diff, then prefix verification. Prefix verification moves ahead of projection and diff because token measurements are meaningless while the prefix can move, and the shipped `unchanged` flag folds into the diff phase instead of standing beside it. `unchanged` fires only when an action leaves the indexed set identical — a bounded wait, a no-op click, a retry — so it never helps a navigating step, and it has no consumer outside `tool-browser` since Obsidian knowledge was decoupled ([obsidian knowledge independence](../../implemented/architecture/2026-09-10-obsidian-knowledge-independent-of-browser.md)); if the baseline shows it rarely fires, it is deleted rather than kept as a weaker diff.

Offload and vision stay last: nothing measured so far justifies them, and the plan gives up building a browser planner or workflow DSL, because snapshot and history size — not round-trip count — is the cost under attack.

## Alternatives considered

**Rewrite the snapshot as a full accessibility-tree serializer.** It would remove more markup, but it duplicates PageController's index and action semantics and makes non-compliant pages harder to operate. The projection keeps PageController as the source of element references.

**Infer decorative nodes from tags or layout.** Tag- and layout-based heuristics vary across sites and hide useful context. The filter stays on page-authored signals, matched by attribute name.

**Keep `unchanged` and add the revision diff on top.** Two mechanisms would overlap on the same payload, and `unchanged` is a strictly weaker diff with no external consumer. The diff absorbs it.

**Ship more reductions before measuring.** This is what already happened. It works until a reviewer asks what it bought; without Phase 1 there is no answer, and the ignored-node filter's two substring defects were found by reading code, not by a failing benchmark.

**Build a browser planner or workflow DSL.** No evidence round-trip count is the bottleneck. Add it only if a benchmark shows round-trips, not snapshot size, dominate.

## Acceptance criteria

- A benchmark reports p50 and p95 browser tokens and round-trips before and after each phase; task success does not fall materially, stale-index failures do not rise, and the full-state fallback still works.
- The session log and replay are unchanged, and no model-visible data exists outside the event log.
- Phase 2: the tool schema and browser instructions are byte-identical across browser steps; only history and page state vary.
- Phase 3: no target control is lost, the parallel comparison lists which controls were removed or merged, and the old and new snapshots both work with `browser_click`, `browser_fill`, and `browser_find`.
- Phase 4: a diff replays to the full state, one tab's change never affects another tab's indices, and an unmatched `baseRevision` returns a full snapshot.
- Phase 5: tool-call/result pairing and the last browser state survive pruning, and the raw log still replays.
- Every phase ships as one PR with regression tests and a keyless snapshot.

## Risks

A projection or filter can drop a real target control. The shipped filter had two substring defects that a name-based match fixes; any further removal needs the same precision and a test that keeps the control.

A diff or revision model can silently invalidate indices. The safe direction is to fall back to a full snapshot whenever a change cannot be proven safe, and a stale-index count in the benchmark is what proves it did not regress.

The percentages in the source research (39.9–59.7%, 60–80%, 70–80%) are directional only. Hydra commits to no figure before it measures its own workflows, which is exactly why Phase 1 comes first.

Phases 6 and 7 add offload lifecycle and vision cost. They stay deferred until measurements justify them, and their absence is not a plan failure.

Pages without usable accessibility signals are the standing fallback case. If the projection degrades them, that shows up as a task-success drop in Phase 1's benchmark, and the fallback must stay.
