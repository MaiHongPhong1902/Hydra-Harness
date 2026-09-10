# Agent Note: Resend unchanged prompts from the inline editor

Status: implemented

## Problem

Requesting another answer does not require changing the prompt. Requiring a text difference prevents the inline editor from serving that action.

## Decision

Save & resend and Enter accept an unchanged draft through the existing `session.revise` edit operation. The selected prompt receives a fresh response in a stored conversation version, with its exact text and retained images. This supersedes only the unchanged-draft restriction in the [prompt-editing decision](../feature/2026-09-06-edit-sent-prompts.md); its immutable history and admission rules remain authoritative.

## Alternatives considered

**Require a text change.** This forces an irrelevant edit to request another answer.

**Use the failed-generation retry operation.** That operation requires a failed or interrupted revision. The editor also resends completed prompts and earlier turns, which the existing edit operation already supports.

## Consequences

Resending creates a conversation version without including the selected prompt's old answer or later turns in the new model request. Blank drafts without images remain blocked. Component checks cover button and Enter submission; the real Web scenario pins the enabled editor, model context, unchanged source log, and resend after reload.
