# Browser Context-Cost Reduction — Specification

## Goal

Cut the model-facing context cost of browser work — tokens at p50 and p95, and the number of round-trips — while holding four things fixed: the element-index / `tabId` / `BrowserState` contract, the completeness of the session log and replay, current security behavior, and action accuracy including the fallback for pages without usable accessibility signals.

Two budgets bound every trailing snapshot: `DEFAULT_MAX_STATE_CHARS = 16_000` for a full state read and `DEFAULT_COMPACT_STATE_CHARS = 4_000` for the snapshot after an ordinary action (`packages/browser/tool-browser/src/render.ts`). The cost under attack is the repetition of those snapshots across a long run, not any single one.

## Non-goals

No browser planner and no workflow DSL. A benchmark must show that round-trip count, not snapshot or history size, is the bottleneck before either is considered.

No new vision pipeline. Phase 7 reuses the existing `browser_screenshot` path and the composer's annotation path.

No change to PageController's action semantics or to index ownership. The model projection may drop a line; it never renumbers PageController's selector map.

No snapshot offload and no vision default before Phases 1–5 produce measurements that justify them.

## Current state

The seam's state is `BrowserState` and one action's report is `BrowserOutcome` (`packages/browser/browser-electron/src/types.ts`, lines 23 and 147). The model-facing value is `BrowserToolValue` (`packages/browser/tool-browser/src/render.ts`, line 33) carrying `header`, `content`, `footer`, `tabs`, `tabId`, `activeTabId`, `settled`, `capturedAt`, `truncated`, `compact`, and `unchanged`. Every `browser_*` tool funnels through `run()` (`packages/browser/tool-browser/src/index.ts`, line 349), which asks `ctx.browsers.perform` for the outcome, decides full versus compact from `FULL_SNAPSHOT_METHODS`, and keeps a per-agent, per-tab `previousContent` map.

Three reductions already ship. `dropIgnoredNodes` removes lines whose tag declaration carries an `aria-hidden="true"`, `role="presentation"`, `role="none"`, or `inert` attribute, matched by attribute *name*; `rankElementList` orders newly appeared and typical form controls first; `compactHeader` shortens the header. Compact results with identical normalized content within the same tab report `unchanged: true` and omit the list, reusing the previous result's indices.

Two facts constrain the projection and are easy to get wrong. The vendored `PageController` already drops an `aria-hidden="true"` node and its entire subtree during DOM-tree construction (`packages/browser/browser-electron/third-party/page-agent/packages/page-controller/src/dom/dom_tree/index.js`, line 1496), so that node never reaches Hydra's projection. And `isInteractiveElement` (same file, roughly lines 802–846) returns `false` for a natively `disabled` `button`, `input`, `select`, or `textarea`, so a disabled native control is never indexed and never reaches the model at all.

The preload configures PageController's serialized attributes with `includeAttributes: ['disabled', 'aria-disabled', 'href']` (`packages/browser/browser-electron/electron-app/preload.entry.js`, line 703), merged with PageController's own default list (`.../dom/index.ts`, line 198). `flatTreeToString` renders each attribute unquoted as `key=value` (same file, line 372), which is why any marker match must be name-based.

The compaction seam exists and is model-free: `ctx.toolResultPruner.pruneSession(session)` rewrites an over-budget `tool/result` to a bounded head, a fixed marker, and a bounded tail, appending a replacement event via `surfaceOp: { op: 'replace', start, end }` and retaining the original in the append-only log (`packages/compaction/compaction-tool-result-pruner/src/index.ts`; config `thresholdChars` 8192, `headChars` 4096, `tailChars` 1024).

The benchmark corpus does not exist. `examples/acp-agent/browser-snapshot-backend.mjs` is a deterministic stand-in for the Electron child that serves exactly one two-element page with a before/after pair. There is no corpus of the six scenarios this spec needs and no metric capture.

## Cross-cutting rules

Every model-visible change updates `docs/subsystems/browser.md`, regenerates the tool catalog (`pnpm run gen-tool-catalog`), and updates the Agent Note that owns the decision.

Each phase is one PR carrying regression tests and one keyless assembled snapshot (a snapshot produced by a real assembled deployment with no secrets), following the existing pattern in `packages/browser/tool-browser/tests`.

No model-visible data may live outside the session log. A diff, a summary, or an offloaded handle is stored as an event, not in an in-memory structure that replay cannot reconstruct.

Any removed line is removed by a rule that names a page-authored attribute or an explicit structural fact; never by a raw substring and never by inferring intent from a tag name.

## Phase 1 — Baseline and telemetry (retrofit)

Goal: produce the before/after numbers every later acceptance criterion depends on, and make them reproducible.

Benchmark corpus. Six scenarios, each a deterministic page served by a scripted child like `browser-snapshot-backend.mjs`: a login form; a long data table with more rows than the viewport; a single-page app that updates one region in place; a page with a nested dialog layer; a page with poor accessibility (few roles, generic `div`s with click handlers); and a multi-tab workflow that opens a link into a second controlled tab and returns.

Page sources live beside the fixture, one module per scenario, exporting the pre-action and post-action `BrowserState.content` strings. The existing two-element page becomes the smallest scenario rather than the only one.

Metrics. Per browser call: tool name, `tabId`, snapshot characters (`header + content + footer` length) both raw and as delivered, the compact/truncated/unchanged flags, action wall time, and `isError`. Per task: total browser tokens counted with `packages/llm/token-meter`, browser round-trips, stale-index failures, `browser_state` re-reads, and task success.

A stale-index failure is precise: a `browser_click`, `browser_type`, `browser_select_option`, `browser_upload_file`, or `browser_fill` naming an index that the immediately preceding result for that same tab did not list, and that fails as a result.

Retrofit. The two shipped reductions have no numbers. Capture the corpus metrics once from the parent of the shipped reduction (the tree before `dropIgnoredNodes` and `unchanged` existed) and once from the current tree, and commit both tables as `examples/acp-agent/browser-bench/`. The harness is a script that runs the six scenarios through the real service, real NDJSON framing, real tools, and real bounding, with only the child process faked — the same seam the existing fixture already uses.

Deliverables: the scenario modules, a `browser-bench` runner, a committed `baseline.json` (pre-reduction) and `current.json`, and a short table in `docs/subsystems/browser.md` or the package README recording both.

No model-visible change. Acceptance: the harness runs offline and deterministically, prints p50/p95 snapshot characters and tokens per scenario, and reproduces the two committed tables byte-for-byte on a rerun.

## Phase 2 — Prefix stability and cache verification

Goal: prove that the dynamic snapshot reaches the model only through history, so every later token measurement is meaningful.

The request order must hold at system prompt, then tool definitions, then static browser instructions, then dynamic page state and history. Nothing variable may enter the system prompt or a tool definition.

Tests, in `packages/browser/tool-browser/tests`:

- Assemble the model request across two consecutive browser steps and assert the system-prompt sections and every tool definition are byte-identical; only history and page-state blocks differ.
- Assert `BROWSER_PROMPT_TEXT` is a pure constant with no interpolation of URL, page content, or telemetry.
- Assert a browser call mutates no tool schema: capture the registered schema set before and after a `browser_state` call and compare.
- Assert the only thing that invalidates the prefix is plugin registration or unregistration.

No model-visible change. Acceptance: identical prefix bytes across browser steps; a failing test would show which section moved.

## Phase 3 — Snapshot projection and downsampling

Goal: hand the model a named accessibility field set instead of PageController's raw line format, and remove the lines that carry no action value — using the existing filter and preload attribute list, not a second serializer.

The projection guarantees, for each indexed control: its PageController index; its tag or role; its accessible name; its value or state; its checked and expanded state where applicable; its disabled state where an author marked it; and its `href` or `target` where present. Most of these already arrive through `includeAttributes`; the phase makes the set explicit and tested rather than incidental.

Removals are limited to page-authored signals plus one structural case:

- `role="presentation"` and `role="none"`, which PageController does not remove today.
- `inert`, likewise.
- Non-indexed lines that carry no visible text after their attributes are removed (an empty presentational container), and only when the removal cannot drop a control: a line with a numeric index is never removed by this rule.

`aria-hidden="true"` is explicitly out of scope: the vendor already drops it with its subtree.

Every marker is matched as an attribute name, per the shipped fix; a value such as `data-state=inert` or `href=/docs?role=none` belongs to a control the model must keep.

`disabled` coverage is partial by construction. A natively disabled `button`/`input`/`select`/`textarea` is not indexed, so it never reaches the projection; only `aria-disabled` on an indexed control and a `disabled` attribute on a custom interactive element surface. The spec does not promise full disabled projection. Reaching the native case would require a vendor change and is tracked as an open question, not as this phase's work.

Fallback. When a page yields too few role or name signals for the projection to be meaningful — for example, a page of generic `div`s — the raw DOM text is used unchanged. The projection never removes a line that carries visible text and a numeric index.

Size target. The original "at least 30%" is not committed here. Phase 1 sets the baseline and the target is derived from it.

Acceptance: a parallel comparison over the corpus lists every control removed or merged by the projection, and the list contains no control that carried a numeric index and visible text; the old and the new snapshot both work with `browser_click`, `browser_fill`, and `browser_find`; the corpus size reduction is reported against the Phase 1 baseline rather than an absolute figure.

## Phase 4 — Per-tab state diff

Goal: replace the full payload after a small action with a structural diff, and retire the boolean `unchanged`.

Host state, replacing the `previousContent` map in `packages/browser/tool-browser/src/index.ts`:

```ts
interface TabSnapshotState {
  tabId: number
  revision: number
  contentHash: string
  elements: string[]
}
```

`revision` starts at 1 for a tab and increments whenever the normalized element list changes; `contentHash` is a short digest of that list; `elements` is the normalized list (after `dropIgnoredNodes` and `rankElementList`).

Model-facing addition to `BrowserToolValue`:

```ts
interface BrowserDiffValue {
  mode: 'diff'
  baseRevision: number
  revision: number
  added: string[]
  changed: string[]
  removed: string[]
}
```

Rules for choosing full versus diff:

- Full when the method is `get_browser_state` or `navigate` (the existing `FULL_SNAPSHOT_METHODS`), when the URL changed, when there is no prior state for the tab, or when the caller's `baseRevision` does not match the stored revision.
- Full when the change is large: when more than half the lines are added, changed, or removed, the diff is not worth its own framing.
- Diff for a small click, type, select, scroll, or wait that leaves most lines intact.
- `browser_state` always returns a full snapshot, and the model always has a way to ask for one.

Indices are invalidated whenever a change cannot be proven safe; the safe direction is always a full snapshot. `formatBrowserOutput` renders a diff as added, changed, and removed lines with the revision pair, and keeps the unchanged notice's replacement explicit: an empty diff still states the revision and that indices remain valid.

`unchanged` is retired into this model. It fires only when an action leaves the indexed set identical — a bounded wait, a no-op click, a retry — so it never helps a navigating step, and it has no consumer outside `tool-browser` since Obsidian knowledge was decoupled. If Phase 1 shows it rarely fires, it is deleted with its notice rather than kept as a weaker diff.

Tab isolation: one tab's entry is never read or written for another tab; closing a tab deletes its entry (the existing cleanup loop already does this).

Acceptance: a diff replays to the full state; no cross-tab effect; the stale-index count does not rise above the Phase 1 baseline; an unmatched `baseRevision` yields a full snapshot.

## Phase 5 — Browser-aware trajectory pruning

Goal: drop browser results that no longer matter from the model surface, using the existing model-free pruner rather than a second history system.

Extend `@hydra/harness-compaction-tool-result-pruner` with a browser-aware classifier. The pruner already replaces an over-budget result with a bounded head, marker, and tail; this phase adds a policy that decides *which* browser results to replace and *what* to keep, before the blind head/tail cut applies.

Classes:

- useless — an intermediate snapshot that no later action referenced and that a later snapshot on the same tab supersedes.
- redundant — a snapshot whose `contentHash` equals a later snapshot's on the same tab.
- expired — a snapshot superseded by a navigation or a newer revision on the same tab.

Retention, mandatory: the last snapshot per tab, any error result, any result the user's decision depended on, an intact tool-call/result pair, and the state the next action needs. A replacement keeps `callId`, `turn`, `step`, and `meta`, using the existing `surfaceOp: { op: 'replace', start, end }` form.

Policy: model-free pruning runs first and a cheap model is used only when pruning is insufficient; a sliding window bounds how far back the pass looks; a minimum token threshold keeps short steps out; only a recent region is pruned. The host decides; the model never calls an erase.

Acceptance: tool-call/result pairing survives, the last browser state per tab is present after a pass, the raw log still replays, and input tokens decrease on the Phase 1 long-run scenario.

## Phase 6 — Snapshot offload

Deferred until Phases 1–5 measurements still show the snapshot as the bottleneck.

Store the full snapshot in session-owned storage with a `snapshotId`, recorded as a session event so replay can reconstruct it. Context keeps the current URL, title, revision, a summary, the needed interactive controls, and the `snapshotId`. Reads become targeted: a subtree by root, an element by reference, the region around a control, or the full snapshot on request — exposed as an argument on the existing `browser_state` rather than a new family of tools. No temp file without a lifecycle, and no model-visible data outside the log.

## Phase 7 — Conditional vision

Deferred. Text and accessibility stay the default. A screenshot is used only when they are insufficient, when z-order or an overlay matters, when the user asks to see the interface, or when an action needs visual information the DOM cannot express. The existing `browser_screenshot` tool and the composer annotation path are reused; no screenshot is attached to an ordinary action.

## Sequencing and PR plan

Phase 1 (baseline and telemetry) → Phase 2 (prefix verification) → Phase 3 (projection) → Phase 4 (state diff) → Phase 5 (trajectory pruning) → Phase 6 (offload) → Phase 7 (vision).

This order differs from the first draft, which ran baseline, projection, diff, then prefix verification. Prefix verification moves ahead of projection and diff because token measurements are meaningless while the prefix can move, and the shipped `unchanged` flag folds into the diff phase instead of standing beside it.

## Acceptance criteria

A benchmark reports p50 and p95 browser tokens and browser round-trips before and after each phase, on the six-scenario corpus.

Task success does not fall materially, stale-index failures do not rise above the Phase 1 baseline, and the full-state fallback still returns a usable snapshot.

The session log and replay are unchanged, and no model-visible data exists outside the event log.

Phase-specific: Phase 2 shows a byte-identical prefix across browser steps; Phase 3 reports which controls the projection removed or merged and keeps every indexed control with visible text; Phase 4 shows a diff replaying to full state and no cross-tab index effect; Phase 5 shows pruning preserving pairing and the last state per tab.

Each phase ships as one PR with regression tests and a keyless assembled snapshot.

## Risks

A projection or filter can drop a real target control. The shipped filter had two substring defects that a name-based match fixed; any new removal needs the same precision and a test that keeps the control.

A diff or revision model can silently invalidate indices. The safe direction is a full snapshot whenever change cannot be proven safe, and the benchmark's stale-index count is what proves no regression.

Pages without usable accessibility signals are the standing fallback case, and a task-success drop on that scenario is the signal that the projection went too far.

The percentages in the source research (39.9–59.7%, 60–80%, 70–80%) are directional only. No figure is committed before Hydra measures its own workflows, which is why Phase 1 comes first.

Phases 6 and 7 add offload lifecycle and vision cost, and their absence is not a plan failure.

## Open questions

Whether offload is needed at all, pending Phase 1–5 measurements.

Whether a vendor change to index natively disabled controls is worth its risk, given that the projection can only partially report disabled state today.

Whether the diff's full-state threshold should be a ratio of changed lines or an absolute count, and where that threshold is configured.
