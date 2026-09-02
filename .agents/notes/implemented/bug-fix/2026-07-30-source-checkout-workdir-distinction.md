# Agent Note: Source checkout paths do not define working directories

Status: implemented

## Problem

The `harness:source` prompt section follows the [source-location decision](../../archived/feature/2026-07-21-dsh-system-prompt-source-path.md), but its original wording called the checkout “your own source code” without distinguishing that path from the session workspace. In a normal TUI configuration that does not state `{{cwd}}` in its persona, this may be the only fixed absolute path near the start of the system prompt. DeepSeek V4 could therefore answer “what's the workdir?” with the harness checkout instead of determining the session's current working directory.

A blanket statement that the checkout is not the working directory would also be false. `bh meta` intentionally makes the source checkout both values.

## Decision

The section identifies the path as the “Bosch Harness implementation checkout.” It says that the checkout location and current working directory are separate values that may differ, forbids inferring the working directory from the checkout path, directs the model to use `pwd` only when a concrete task needs that fact, and limits the checkout's purpose to a user request to inspect or extend BH itself. The [intent-first tool-selection decision](2026-08-31-intent-first-tool-selection.md) makes the conditional wording part of the wider conversational boundary.

The path derivation, global `harness:source` ownership, and `-99` ordering remain unchanged. Describing the values as conceptually separate rather than always unequal keeps the instruction accurate in both ordinary project sessions and `bh meta`.

## Verification

The `bh-app-boot` unit test pins the exact text and its ordering. The CLI keyless PTY smoke inspects the assembled request header. The TUI `source-checkout-workdir` snapshot mounts the section with `/opt/bh-source`, asks “what's the workdir?” through a recorded DeepSeek V4 turn, and requires the replayed transcript to run `pwd` and report the generated workspace rather than the checkout.

## Alternatives considered

**Say that the checkout is never the working directory.** Rejected because `bh meta` deliberately makes them the same path.

**Put the current working directory in the global source section.** Rejected because the source section is launcher-global while the working directory belongs to each session; combining them would duplicate the loop's `cwd` ownership and make a stable source fact vary per agent.

**Remove the source path from the prompt.** Rejected because self-referential BH tools still need a reliable checkout location when the launcher starts from an unrelated project.

## Consequences

The prompt is longer and a direct working-directory question may spend one inexpensive `pwd` tool call. In exchange, the model no longer treats the harness implementation path as an implicit task workspace, while meta mode remains truthful when both values coincide.
