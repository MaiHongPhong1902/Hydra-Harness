# Agent Note: Prompt edits stay in one conversation

Status: implemented

## Problem

The [sent-prompt editor](../feature/2026-09-06-edit-sent-prompts.md) preserves prior model history through a before-turn fork, but presenting every stored continuation as a new sidebar chat makes editing behave like branching. The user expects the revised prompt and response to replace the displayed turn, with older versions still accessible.

## Decision

Before-turn forks record `session/revision`: the owning session, original conversation, previous version, edited turn, and creation time. This ignorable log-only event does not enter model history. The API proxy validates it and includes the owned record in list summaries, creation frames, and the fork reply. Its versioned list-metadata projection restores the same identity from cold logs. An ordinary fork can inherit the event but does not own it, so it remains a separate chat.

The runtime groups these identities. Workspace grouped, flat, and search views show the selected version, otherwise the newest version, as one conversation row; archiving a member hides that conversation. The conversation header offers Previous/Next and Current version, while edited-turn user actions expose See versions. Navigation restores the entire matching transcript. Editing a running response cancels it before creating the replacement. Images and rejected prompt drafts use the existing input machine.

## Alternatives considered

**Overwrite or truncate the source log.** This loses the actual input associated with prior responses and tool effects. Immutable transcripts retain version history and reconstructable model requests.

**Hide forks using browser-only state.** Another browser or a Host restart would list the versions as unrelated chats. Durable revision identity travels with the stored transcript.

**Group every fork.** Explicit assistant and sidebar branching still creates a new conversation; only before-turn editing records revision ownership.

## Consequences

The chat list does not grow when a prompt is edited. Revision storage still uses independent append-only sessions and does not undo external tool effects. Host tests cover ownership, repeated edits, ordinary forks, and invalid anchors; list tests cover grouped, flat, search, and archive behavior. The assembled keyless Web scenario checks one sidebar row, replacement model input, version navigation, and reload persistence. SDK model output is unchanged because the revision record is GUI metadata and is never added to the model surface.
