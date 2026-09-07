# Agent Note: Prompt edits stay in one conversation

Status: implemented

## Problem

The [sent-prompt editor](../feature/2026-09-06-edit-sent-prompts.md) preserves prior model history through a before-turn fork, but presenting every stored continuation as a new sidebar chat makes editing behave like branching. The user expects the revised prompt and response to replace the displayed turn, with older versions still accessible.

## Decision

Before-turn forks record `session/revision`: the owning session, original conversation, previous version, edited turn, and creation time. This ignorable log-only event does not enter model history. The API proxy validates it and includes the owned record in list summaries, creation frames, and the fork reply. Its versioned list-metadata projection restores the same identity from cold logs. An ordinary fork can inherit the event but does not own it, so it remains a separate chat.

Prompt admission through `session.revise` adds a stable user `revisionId`, generation `attempt`, and durable admission receipt. Generation retries retain the same revision identity and creation time, so the picker selects the viewed attempt or the highest available attempt for each user revision. Source-version labels resolve the stable revision identity even when its representative is a later generation attempt. All attempt logs remain stored.

The runtime groups these identities. Workspace grouped, flat, and search views show the current version, then the last viewed member, then the newest, as one conversation row; archiving a member hides that conversation. The browser selection store remembers the viewed member per conversation across navigation, clear, and reload. A missing or unrelated remembered member falls back to the newest. The header offers Previous/Next and the viewed version number. The header and the user prompt whose turn was revised expose a history icon and numbered picker listing the original conversation, each edited prompt's turn, and its source version. Later unedited prompts keep Copy and Edit only. Latest identifies the newest version; Viewing identifies the selected transcript. Opening the picker preserves the transcript; choosing a version restores its entire transcript. The picker supports arrow keys, Home/End, Enter, and Escape. The Host drains a running response before admitting its replacement; failed admission retains the inline draft and leaves selection unchanged.

## Alternatives considered

**Overwrite or truncate the source log.** This loses the actual input associated with prior responses and tool effects. Immutable transcripts retain version history and reconstructable model requests.

**Hide forks using browser-only state.** Another browser or a Host restart would list the versions as unrelated chats. Durable revision identity travels with the stored transcript.

**Group every fork.** Explicit assistant and sidebar branching still creates a new conversation; only before-turn editing records revision ownership.

## Consequences

The chat list does not grow when a prompt is edited. Revision storage still uses independent append-only sessions and does not undo external tool effects. Host tests cover ownership, repeated edits, ordinary forks, and invalid anchors; list tests cover grouped, flat, search, and archive behavior. The assembled keyless Web scenario checks one sidebar row, replacement model input, version navigation, and reload persistence. SDK model output is unchanged because the revision record is GUI metadata and is never added to the model surface.
