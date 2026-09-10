# Agent Note: Permission preset labels and ask-user semantics

Status: implemented

## Problem

Permission presets exposed machine-oriented labels such as Read Only, Workspace Write, and Full access. The execution approval flow and the clarification flow were also easy to conflate: Auto-Pilot should remove permission prompts without removing the ability to ask for information that only the user can provide.

## Decision

The browser labels the built-in presets as **Read only**, **Edit**, and **Auto-Pilot** while retaining `read-only`, `workspace-write`, and `danger-full-access` on the wire. Auto-Pilot keeps the existing `approval: never` policy, so acting tools do not ask the user to approve execution. The `ask_user_question` tool remains available for a genuine user-owned choice or material information missing from normal inspection, including when approval prompts are disabled. Its answer never grants execution permission or overrides a denial, and permission requests are excluded from its model-facing description.

The composer, current-session picker, and General settings use the same product labels. The [GUI risk confirmation](2026-07-31-gui-full-access-confirmation.md) still requires explicit acknowledgement before selecting Auto-Pilot. The [intent-first tool selection](../bug-fix/2026-08-31-intent-first-tool-selection.md) decision continues to own when clarification is needed; the generated tool catalog exposes the tool's distinction between clarification and permission.

## Alternatives considered

**Disable `ask_user_question` in Auto-Pilot.** Rejected because missing facts and user-owned choices remain blockers even when execution permission is automatic.

**Use the product labels on the wire.** Rejected because host policy and session projections use the canonical preset ids; presentation changes do not require a protocol change.

**Keep asking for execution permission in Auto-Pilot.** Rejected because it contradicts the preset's `approval: never` behavior and preserves the confusion this change resolves.

## Consequences

Users see task-oriented permission labels and can distinguish automatic execution from necessary clarification. Existing hosts and durable session events keep their canonical ids and approval semantics. The visible Auto-Pilot warning remains the deliberate acknowledgement point, while clarification questions continue through the normal user-questions channel.
