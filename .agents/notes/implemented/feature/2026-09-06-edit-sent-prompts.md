# Agent Note: Edit sent prompts through session-local immutable prefixes

Status: implemented

## Problem

A reader needs to correct a sent prompt and obtain a fresh answer using the preceding conversation. Mutating its logged text leaves the existing answer and tool activity attributed to input the model never received. A branch through the completed answer includes the very turn the reader wants to replace.

## Decision

User and admitted-steering bubbles expose Edit and Retry prompt beside Copy. Retry prompt submits the exact original text through the same immutable revision admission without opening the editor. The inline editor labels the new version, offers Cancel and Save & resend, preserves whitespace and Unicode, and focuses at the end of the original text. Enter sends, Shift+Enter inserts a newline, and Escape cancels and returns focus. IME composition never submits. Blank drafts without images cannot send; [unchanged drafts resend the prompt](../bug-fix/2026-09-08-resend-unchanged-prompts.md). Submission locks synchronously and retains the draft or original text and request identity on failure; success releases the identity so another resend creates a new version. Edit and Retry stay disabled during admission. The generic locale `edit` label remains shared with other editors.

Explicit resend labels distinguish replacement from an ordinary follow-up. Keyboard focus begins at the end of the original text, and visible shortcut hints make the editor usable without discovering hidden keys. The reference points are [Codex desktop keyboard commands](https://learn.chatgpt.com/docs/reference/commands) and [Claude Code conversation rewind](https://code.claude.com/docs/en/checkpointing): recalling text must not submit it, and restoring conversation context must remain distinct from reverting files.

`session.revise` owns admission and generation. The Host verifies the source Workspace, human message, retained image relationships, decoded image limits, and model route before creating a session-local version. An opening prompt excludes its entire turn; a steering prompt keeps earlier events and balances that partial turn with the session recovery helper. The source Agent is cancelled and drained before the replacement prompt starts. Assistant branching retains its completed-turn semantics and [its own affordance](../simplification/2026-08-06-user-bubbles-drop-the-branch-action.md).

Editing changes text only so correcting a prompt cannot silently replace its supporting files. Existing attachments remain visible and use their original content-addressed objects. The editor has no upload or removal controls, and the Host rejects attachment fields on edit requests. The deterministic child id and durable receipt deduplicate reconnects and repeated requests. The prompt is parked in the durable inbox and flushed before Workspace attachment and generation. A terminal generation retry creates a separate attempt log with the same user-message and revision identities, preserving failed output without feeding it back to the model. Retry is refused once a later user prompt has continued the session. The original composer draft is untouched. Unsupported content blocks do not expose this editor. [Conversation versions](../bug-fix/2026-09-06-prompt-edits-stay-in-conversation.md) group stored continuations into one visible chat.

## Alternatives considered

**Overwrite the durable message.** This invalidates model history, answers, and tool effects. Forking preserves a reconstructable record and provides a separate continuation.

**Reuse queue editing.** A queued occurrence has not reached the model. The queue mutation cannot replace a consumed message or remove its answer.

**Retry by appending another prompt to the failed log.** This duplicates human input and can expose failed assistant/tool output to the next request. Independent attempts retain the audit trail while using the same admitted user identity and preceding context.

**Require opening the editor for every fresh response.** The unchanged draft already supports resending, but adds an unnecessary interaction when the reader wants a different answer. A direct Retry prompt uses the same admission operation and preserves its context and image guarantees. Retry response on a failed revision retains its separate generation-attempt semantics.

**Display an inactive pencil or disabled placeholder.** This advertises an action without the Host operation to honor it. The control is available together with before-turn forking and submission.

## Consequences

Sending an edit or retry stores each version in the same append-only session; it does not undo source tool effects. Optional admission fields extend the existing ignorable revision event without a database migration. The real Web composition verifies model-context exclusion, image retention, duplicate admission, direct retry, stored-version navigation without model calls, cancellation, browser reload, fresh-Host log recovery, and edits near the start of 100- and 1,000-message transcripts. Editor and history screenshots cover both themes and narrow panes. Component tests cover draft, keyboard, pending submission, and request-identity reuse behavior. The local Host has no account ACL; source and Workspace checks enforce relationships within its existing single-user trust model.

The [session-local version design](../architecture/2026-10-03-session-local-prompt-versions.md) owns shared-prefix storage, selection, context invalidation, and bounded references between versions.
