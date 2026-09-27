# Agent Note: Randomized turn activity status

Status: implemented

## Problem

Every running agent turn displayed the same `Deep diving...` label, so the activity indicator became repetitive and did not reflect the conversational feel of an active agent.

## Decision

`TurnStatus` selects one phrase from `TURN_STATUS_MESSAGES` with `Math.random()` when the running status mounts, then selects a different phrase every 3.2 seconds while the turn remains active. `ChatView` keys the status by the logged turn start so a new turn resets the rotation, while rerenders and the elapsed-time clock do not. Each phrase enters with a short fade-and-rise transition; reduced-motion preferences disable the visual animations. The web ARIA normalizer replaces the running status copy with `{{turn-status}}`, keeping replay goldens deterministic without hiding the presence of the running indicator.

## Alternatives considered

**Keep the fixed label:** This preserves deterministic output but does not address the repetitive activity copy.

**Rotate the phrase on every timer tick or render:** This creates visual churn and can change the label during an otherwise unchanged turn, so it was rejected in favor of one phrase per turn.

**Derive status text from provider events:** Provider-specific progress would require a broader data contract and is outside this presentation-only change.

## Consequences

The running indicator now has varied Claude-like progress copy, but the phrase is intentionally not a claim about the exact tool or model operation in progress. Replay snapshots normalize the running status copy while retaining the status row itself.

## Testing

The component test pins the random source and fake clock to verify timed rotation, rerender stability, and reset on a new turn. GUI and replayed web tests cover the assembled running status and normalize the intentionally variable copy.
