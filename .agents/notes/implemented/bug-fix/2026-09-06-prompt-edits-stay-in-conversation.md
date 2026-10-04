# Agent Note: Prompt edits stay in one conversation

Status: implemented

## Problem

Editing a sent prompt must preserve its old answer while replacing the displayed turn. A new sidebar chat for each edit separates versions that belong to one conversation.

## Decision

Prompt edits and direct retries create [session-local versions](../architecture/2026-10-03-session-local-prompt-versions.md). One session ID, Agent, Workspace attachment, and durable log own every version. `session/revision` supplies edit metadata and a durable admission receipt; core creation and selection records determine the transcript path. Host summaries and version-change frames carry the version catalog and current selection to connected clients.

The header and revised prompt offer Previous/Next and a numbered history picker with original, latest, viewed, and source-version labels. Choosing a version restores its entire transcript without generating. Selecting a reference queues that version's bounded recall for the next prompt. Arrow keys, Home/End, Enter, Escape, and focus return work across the picker; an admission failure retains the inline draft and request identity.

## Alternatives considered

**Overwrite the prompt.** Existing answers lose their actual input. **Hide cloned sessions through browser state.** Storage and context still diverge across versions, and another client needs the hidden-session grouping. Session-local paths preserve provenance with one storage identity.

## Consequences

Editing does not create hidden sessions or undo tool effects. Ordinary explicit forks remain separate chats. A Host restart restores the selected version from the same durable log. The keyless assembled Web scenario checks replacement model input, one session identity, version navigation, references, and reload persistence.
