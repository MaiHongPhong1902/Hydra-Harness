# Agent Note: Beautify chat agent activity

Status: implemented

## Problem
Tool executions and subagent operations were rendered as raw JSON strings in the chat session (for example, `subagent · {"prompt": "..."}`). When expanded, the tool card rendered the full arguments JSON block. This cluttered the conversation interface with technical wire representation even though raw details and execution telemetry already live authoritatively in the Trajectory view.

## Decision
Register a dedicated `SubagentRow` (`subagent-row.tsx`) under the `subagent` toolview slot to present delegations with a branching icon, a clean title (`Subagent`), task description as the summary, an optional `(background)` indicator, and a readable task prompt on expansion.

Extend `GenericToolCard` to consume `block.callView` when `card === 'generic'`, honoring the tool's declared `title`, mapping `genericCall.kind` to appropriate tool row icons (`execute`, `read`, `write`, `search`), and rendering `genericCall.rawInput` when present instead of full raw args.

Add `presentCall` to the `subagent` tool definition so any generic consumer receives clean title and prompt presentation intents.

Classify `subagent` tools under `'other'` in `ActivityGroup` so grouped assistant operations show "Ran tools" instead of defaulting to "Ran commands".

Extend fallback summary keys in `tool-call-model.ts` to inspect common descriptive fields before falling back to raw JSON arguments.

## Alternatives considered
- **Relying solely on Trajectory view**: Keeping chat view showing raw JSON was rejected because the chat view is the primary conversation reading surface and should emphasize readable intent.
- **Parsing arbitrary JSON on the client without tool hints**: Attempting to heuristically format arbitrary arguments without presenter intents is fragile. Using `presentCall` and standard `callView` intents allows tools to own their human-facing labels.

## Consequences
Subagent calls and generic tools with `presentCall` render as clear, readable summary cards in chat transcripts. Monospace raw JSON blocks are removed from the default expanded view, while the "Inspect" button preserves the affordance to view full raw events in the Trajectory view.
