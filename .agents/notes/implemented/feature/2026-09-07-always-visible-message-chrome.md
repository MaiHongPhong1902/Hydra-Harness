# Agent Note: Always-visible message action chrome

Status: implemented

## Problem

Hover-hiding the message clock and Edit pencil made those controls easy to miss beside Copy, which stayed visible. Readers looking for when a prompt was sent, or how to edit it, had to discover a hover target first.

## Decision

The message action row shows time, Copy, Edit, and branch at rest. `MessageIconActions.module.css` applies no hover opacity. User and assistant rows no longer carry `data-time-hover-root`.

This reverses the hover-reveal clause of the [turn run-time chrome](./2026-08-03-web-turn-run-time.md). Turn wall-time derivation, the 15-second live clock, and live-region exclusion are unchanged.

## Alternatives considered

**Keep hover-gating for time only.** The clock sits in the same row as Copy and Edit. Hiding it while showing those icons is inconsistent and still hides arrival time.

**Hide the whole row until hover.** Copy and Edit must stay discoverable, and hiding the row also shifts layout.

## Consequences

The transcript is denser at rest on hover-capable pointers. Touch and pointer devices share the same chrome. Component coverage asserts Copy on both user and assistant rows and the settled `Ran for` label without a hover gesture.
