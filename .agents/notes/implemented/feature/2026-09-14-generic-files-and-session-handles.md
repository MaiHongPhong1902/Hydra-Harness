# Agent Note: Generic files use immutable references and session-owned handles

Status: implemented

## Problem

Binary files need durable storage and model-visible history without placing their bytes in session JSON or provider requests. Persistence consumers also need one lifecycle owner for a session log.

## Decision

The attachment service stores file bytes content-addressably and records a `FileAttachmentRef` in the session event. LLM request assembly replaces each file block with deterministic read-only handle text, resolving a process path only when the mounted filesystem can read the host object. The browser upload carrier streams `Blob` or `ReadableStream` bodies to an authenticated raw-byte route.

`SessionPersistence.open()` returns a read or exclusive write `SessionHandle`. Handles own close and cancellation checks; a backend instance rejects a second write owner for the same session and releases ownership on close.

## Consequences

- Session history remains JSON-safe and replayable while large bytes stay outside the log.
- Providers never receive opaque file blocks or unbounded encoded payloads.
- A cross-process lease is still a backend responsibility; the current lock protects one persistence instance.
