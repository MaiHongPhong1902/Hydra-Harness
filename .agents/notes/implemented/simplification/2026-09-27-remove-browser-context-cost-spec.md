# Agent Note: Remove the standalone browser context-cost specification

Status: implemented

## Problem

The root `BROWSER_CONTEXT_COST_SPEC.md` duplicated the browser context-cost proposal already owned by the active browser Agent Note and recorded phase details beside the shipped browser contract. The repository has a six-scenario benchmark, committed baseline/current measurements, and shipped per-tab structural diffs, so the long-form root draft can drift from the implementation while still looking authoritative.

## Decision

The root specification is deleted. The active [browser context-cost proposal](../../proposed/architecture/2026-09-10-browser-context-cost-reduction.md) owns the rationale, scope corrections, alternatives, remaining phases, and acceptance criteria. The shipped behavior is documented by the [browser subsystem reference](../../../../docs/subsystems/browser.md) and the [browser benchmark](../../../../examples/acp-agent/browser-bench). The proposal no longer links to the deleted root file.

The deleted file did not define a runtime, wire, durable-session, configuration, or generated-file contract. Future context-cost work updates the active proposal, subsystem reference, benchmark measurements, tests, and snapshots together.

## Alternatives considered

**Keep the root specification beside the Agent Note.** Rejected because two current owners invite contradictory edits and the root file already lagged the shipped benchmark and diff behavior.

**Copy the entire draft into a second implemented note.** Rejected because the active proposal already retains the durable rationale and acceptance criteria; copying the phase prose would recreate the duplicate owner under a different path.

**Delete the file without repairing the proposal link.** Rejected because it would leave a broken active-document reference and make the remaining proposal harder to discover.

## Consequences

The browser context-cost decision has one active proposal and one shipped subsystem reference. The detailed draft's implementation sketches are no longer current authority; a future offload or vision decision must be justified by the benchmark and recorded in the active proposal before implementation.
