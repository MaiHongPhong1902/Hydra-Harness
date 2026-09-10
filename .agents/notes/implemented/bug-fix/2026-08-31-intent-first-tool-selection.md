# Agent Note: Intent-first tool selection for conversational turns

Status: implemented

## Problem

A Web session whose only user message was `hi` opened an `ask_user_question` generic action menu, then ran PowerShell `pwd`. The model-visible source-checkout text unconditionally instructed it to determine the working directory, while the question tool described generic missing information as a valid reason to ask. Neither behavior was needed to answer a conversational turn.

A later Browser replay found two related decision failures. A direct “improve agent” request could produce a broad plan after inspecting unrelated workspace samples, and a read-only review attempted `read` with `limit: 4000` even though the runtime cap was 2000. The old tool schema described the cap in prose only, so the model-facing contract did not expose it structurally.

## Decision

The request prefix separates conversation from work. Greetings, acknowledgements, casual chat, and vague requests receive a direct reply without tools, workspace inspection, or a generic action menu. For a concrete task, the agent chooses the smallest useful tool path and proceeds. It asks only for a genuine user-owned choice or a material fact that normal inspection cannot establish. Execution permission follows the current sandbox and approval policy through the acting tool's approval flow; an `ask_user_question` answer neither grants permission nor overrides a denial. Necessary clarification questions remain available when approval prompts are disabled, including Auto-Pilot.

The source-checkout section tells the agent to run `pwd` only when a concrete task needs the current working directory, and to use the checkout only when the user asks to inspect or extend Hydra. The Web section carries the intent-first policy because it owns the interactive browser surface. Its `agent/pre-step` contract makes direct agent-improvement requests inspect evidence before plans, goals, or approval menus; if no directly relevant decision failure is found, it must name the concrete evidence needed for one narrow next check and stop. The `ask_user_question` schema independently excludes conversational turns and generic action, task, and tool menus, so the policy remains visible wherever that tool is available.

The shared JSON-schema subset and author DSL now support inclusive numeric `minimum` and `maximum`, and the filesystem `read` tool declares `offset` as a positive integer and `limit` as an integer bounded by its deployment cap. Runtime argument validation remains as defense in depth. This gives the model the same `limit <= 2000` boundary that the executor enforces.

This extends the greeting/casual-turn boundary in [bounded skill routing](../architecture/2026-08-25-bounded-skill-routing.md). It refines the source-checkout wording in [source checkout paths](2026-07-30-source-checkout-workdir-distinction.md) and the Web request prefix in [Web runtime context](2026-07-28-web-agent-runtime-context.md).

## Distillation evaluation

Each evaluation writes the task, allowed actions, and independently observable oracle before a run. The evaluator then reads every user-visible assistant text response in chronological order, not only the closing response, and compares each factual claim with the oracle. Tool calls establish action compliance but cannot establish that the prose answer is correct. A streamed text claim remains evidence when the user could see it; a tool-call-only assistant message is not scored as a prose claim.

The critical dimensions are task compliance, factual grounding, scope and action compliance, safety, response quality, and stream consistency. A factual contradiction, prohibited action, safety failure, or contradictory user-visible response fails the run even if a later response corrects it. An absent or insufficient oracle is `inconclusive`, not pass. A positive distillation sample requires every critical dimension to pass in three independent clean runs; a one-off case pass remains diagnostic evidence only.

The ordered-log probe records `ask_user_question` at sequence 165 before `pwsh` at sequence 187 after `hi`; the baseline answer named `pwsh` because it skipped the interaction tool. Three clean replays read the log once, named `ask_user_question`, and made no shell call. A replay that first attempted an invalid read limit and retried is excluded from positive samples even though its final answer was correct.

The coordination probe has a four-line oracle for each sample file, one delegated inspection of `sample_search_test2.txt`, and one direct inspection of `sample_search_test.txt`. Its baseline first told the user that the direct file had six lines despite the returned total of four, then corrected the number later. The correction does not qualify the run. The three later replays respectively duplicated delegated and direct evidence, started two children and interrupted one, or re-read the delegated file directly. The final prose could be correct, but none is a positive sample because scope or stream requirements failed.

The current 15-case board records T01, T02, T03, T05, T07, T10, T13, T14, and T15 as observed passes; T04 as a factual failure; T08 and T11 as quality warnings; T09 as inconclusive; T06's baseline as a factual failure repaired by the three clean ordered-log replays; and T12 as an unstable strict failure. The board is an evaluation record, not training data: only runs that meet the three-clean-run rule enter distillation.

## Verification

Focused Web, question-tool, JSON-schema, schema-compiler, and filesystem-tool tests pass. `pnpm run build`, generated tool-catalog verification, and type-equivalence verification pass.

Fresh Browser replays confirmed `hi` and `cảm ơn` receive a short response with no tool event; a narrow source review begins with `read` at `limit: 2000` and no cap rejection; and “Tôi muốn cải thiện agent” begins with read-only discovery. After the no-evidence rule, that last case reports the missing decision-log evidence instead of generating a broad improvement plan, approval menu, goal call, or terminal action. Browser evidence also confirms that the Chat transcript renders interim assistant messages and tool actions; the complete event stream is retained as the oracle-audited source rather than inferring quality from the last visible response.

## Alternatives considered

**Add a planner, classifier, or second model call before every turn.** Rejected because this failure is already controlled by the existing request-prefix and tool-schema seams. Another model call would add latency, cost, state, and a new failure mode before even a greeting.

**Reject conversational tool calls in `tools/pre-execute`.** Rejected because tool schemas and the system prompt are assembled before that hook. The user would still see an attempted tool call, and a semantic guard there would require a brittle classifier after the wrong decision was already made.

**Keep numeric limits only in prose.** Rejected because the model can choose a value the executor later rejects. The existing JSON-schema seam is smaller and applies the bound before a tool executes.

**Keep the generic action menu as a safe fallback.** Rejected because selecting a task or tool is the agent's job when the user has not asked for work. A concise conversational reply is the correct fallback; a human question remains available for an actual blocker.

## Consequences

Conversational turns no longer receive an instruction that biases them toward terminal inspection or a menu. Concrete tasks retain tool access and legitimate confirmations or unavailable user-owned facts still use `ask_user_question`. The policy is deliberately one-pass prompt and schema based rather than a planner or execution-time classifier, so model-visible behavior is explicit and request-prefix stable. An individual provider can still violate instructions; numeric schema validation, tool permissions, and approval remain the enforcement boundary for side effects.
