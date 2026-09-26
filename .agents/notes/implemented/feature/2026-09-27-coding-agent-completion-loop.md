# Agent Note: Coding presets keep a focused completion loop

Status: implemented

## Problem

The shipped `standard` and `code` coding presets identified the agent but did not tell it to verify a change or report the resulting diff, so a coding turn could stop after an edit without a focused check.

## Decision

Both coding personas now require the smallest owning edit, the narrowest focused check, a diff inspection, and a report of changed files and exact checks, including failures or unverified surfaces. Composition tests assert the prompt for both presets.

## Alternatives considered

**Add a new runtime completion controller.** This would duplicate the agent loop and impose checks on non-coding tasks.

**Leave the behavior to general instructions.** This keeps the prompt short but does not give coding presets a stable completion contract.

## Consequences

Coding sessions receive a bounded verification reminder without changing tool behavior or requiring a language-server provider. The prompt remains guidance; it cannot prove that an external check succeeded.
