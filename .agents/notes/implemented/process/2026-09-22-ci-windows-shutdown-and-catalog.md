# Agent Note: Windows CI fixture shutdown and generated catalog expectations

Status: implemented

## Problem

The native Electron correctness fixture reported success and then killed its child before Electron flushed the profile, so Windows could fail while the test removed the temporary profile. The Jev decision tool also registered in the runtime catalog before its exhaustive test list was updated.

## Decision

The Electron driver now waits for the child `close` event and requires exit code zero after receiving the transcript. The catalog expectation includes the shipped `browser_decide` schema. Focused coverage tests exercise the attachment file seam, account-backed model settings, and optional Jev provider card.

## Consequences

The profile cleanup runs after Electron has exited, while catalog tests fail when a shipped tool is omitted. The repository coverage gate remains authoritative for unrelated historical gaps.

## Alternatives considered

**Kill Electron after reading the transcript.** Rejected because Windows can still hold Chromium profile handles when the parent removes the temporary directory.

**Remove or lower the coverage threshold.** Rejected because the coverage gate must expose missing behavior tests; the focused additions leave the 100% per-file policy unchanged.
