# Agent Note: Browser UI change delta

Status: implemented

## Problem

Compact browser results showed a structural diff, but the model had no explicit signal that an action exposed a dialog, panel, or disclosure. It therefore reread noisy page content and could mistake an action that opened a same-document surface for navigation.

## Decision

The preload `MutationObserver` marks a document dirty for semantic DOM mutations, waits briefly for the UI to settle, and compares bounded accessibility snapshots. `@hydraharness/harness-tool-browser` exposes the resulting `uiChanges` section with newly shown and hidden lines, disclosure transitions, changed nodes, and focus. The model-facing prompt tells the agent to inspect shown or expanded content first. Existing numeric indexes remain unchanged, and an empty delta is omitted.

## Alternatives considered

- **Raw DOM mutation output** — rejected: the observer is only a wake-up signal; accessibility snapshots remain the source of truth.
- **Expose every DOM mutation** — rejected: animation and carousel mutations would add noise and leak implementation details instead of useful controls.

## Consequences

Compact action output now adds up to 20 entries per UI-change category. The classification is semantic and snapshot-based, so it does not identify changes that never appear in the accessibility tree. Navigation and readiness remain separate; shared observation IDs preserve the net delta across readiness polls.

## Testing

The tool-browser suite covers shown and expanded classification and passes with the existing snapshot ranking tests.
