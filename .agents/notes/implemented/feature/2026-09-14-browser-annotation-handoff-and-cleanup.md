# Agent Note: Browser annotation handoff and cleanup

Status: implemented

## Problem

Browser annotations cross a native Electron picker, a renderer bridge, and session-scoped composer state. Picker completion can race a generated click event, unsupported pages can expose an unusable toolbar action, malformed renderer payloads can enter draft state, and an annotation screenshot can outlive the text card that owns it.

## Decision

The native toolbar enables annotation only for an active HTTP(S) page and exposes an Escape cancellation path with an accessible active label. The picker treats pointerup as authoritative and consumes Chromium's follow-up click, while its status tip is announced to assistive technology. The conversation bridge validates annotation metadata and screenshot fields before creating drafts. Screenshot image ids stay paired with their text attachment for removal, submission ordering, and session/workspace handoff.

## Alternatives considered

Allowing every renderer annotation through the typed callback would keep the bridge small but would trust an unvalidated global payload. Keeping screenshots in the generic image rail would avoid attachment changes but leaves orphaned images and loses the relationship between evidence and its annotation text.

## Consequences

Unsupported pages no longer start a picker that must silently discard its result. Keyboard users can cancel an active picker, and pointer clicks produce one annotation. Invalid payloads are ignored. Removing or moving an annotation also moves or releases its screenshot, and submitted content places each paired screenshot beside its annotation text.

## Testing

Focused conversation tests cover malformed payload rejection and paired screenshot cleanup. Existing Electron picker and native chrome tests cover element/region selection, screenshot policy, stale navigation, and disabled annotation on the initial blank tab.
