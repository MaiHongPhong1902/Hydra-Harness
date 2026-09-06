# Agent Note: Edit sent prompts through a before-turn fork

Status: implemented

## Problem

A reader needs to correct a sent prompt and obtain a fresh answer using the preceding conversation. Mutating its logged text leaves the existing answer and tool activity attributed to input the model never received. A branch through the completed answer includes the very turn the reader wants to replace.

## Decision

Turn-opening user bubbles expose a pencil beside Copy. The inline textarea offers Cancel and Send; Escape cancels, Ctrl/Cmd+Enter sends, and plain Enter inserts a newline. Submission prevents duplicate clicks and keeps an error and the draft visible when attachment retrieval or forking fails. The generic locale `edit` label remains shared with other editors.

`session.fork` accepts `beforeSeq` as an alternative to `atSeq`. The Host verifies that the anchor is the first user message of its turn and seeds the child only through the preceding event. This supports the first message and an active turn without changing or cancelling the source. Assistant branching retains its completed-turn semantics and [its own affordance](../simplification/2026-08-06-user-bubbles-drop-the-branch-action.md).

The client reads the original message's images with source-session authorization before creating the child. It fills the child's existing input machine with the edited text and copied images, opens the child, and submits through ordinary Queue admission. A failed admission retains the child composer draft and attachments for retry. The original session's composer draft is untouched. Unknown non-text blocks and mid-turn steering do not expose this editor.

## Alternatives considered

**Overwrite the durable message.** This invalidates model history, answers, and tool effects. Forking preserves a reconstructable record and provides a separate continuation.

**Reuse queue editing.** A queued occurrence has not reached the model. The queue mutation cannot replace a consumed message or remove its answer.

**Display an inactive pencil or disabled placeholder.** This advertises an action without the Host operation to honor it. The control is available together with before-turn forking and submission.

## Consequences

Sending an edit creates a child conversation; it does not undo tool effects from the source turn. The new answer can reuse only the prefix preceding the edited turn. Images are uploaded again through the existing attachment admission path. Client component tests cover cancel, blank input, pending clicks, and failure retry; Host tests cover first, later, active, and invalid anchors. The real Web composition pins the inline editor and verifies the child history and reply after reload. The shared seed-fixture reader JSON-escapes substituted Windows paths so this browser scenario is portable.
