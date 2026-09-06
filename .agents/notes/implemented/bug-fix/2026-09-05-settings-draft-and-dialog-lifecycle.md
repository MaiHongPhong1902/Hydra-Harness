# Agent Note: Settings drafts, refresh ordering, and modal focus

Status: implemented

## Problem

Settings combines asynchronous Host writes, drafts that survive navigation, and nested dialogs. A successful write can return after newer typing or a newer settings refresh; a preset mutation can complete while an older roster read is pending. Provider creation can persist its profile before a credential failure. Document-level Escape listeners and focus outside a dialog can dismiss or activate controls beyond the user's current editor.

## Decision

The instructions controller distinguishes section entry from explicit reload. Entry refreshes clean content and preserves dirty drafts, conflicts, and pending saves. Save advances the accepted content and revision but replaces the draft only when it still equals the submitted text.

The shared Settings mirror accepts write responses only when their namespace revision is at least the held revision. The General preset row and management controller each own a serialized roster loader; invalidations during a read request one rerun before publication, and callers await its settlement.

Provider creation remembers its successful profile commit independently of directory membership. A credential retry validates its outstanding key without treating that profile as another provider's duplicate. Discovery resolves cleared endpoint and proxy fields from the composition and schema defaults, leaving absent values out of the request.

Settings uses the shared Modal's keyboard lifecycle. The topmost body-portalled dialog owns focus and Escape; Tab wraps over controls found by the maintained `tabbable` package, and dismissal restores a connected opener. Portalled Menu lists attach inside their enclosing dialog and consume Escape before it.

The [Settings mirror](../architecture/2026-08-17-settings-describe-mirror.md), [Personalization](../feature/2026-08-31-settings-personalization-section.md), [provider declaration](../architecture/2026-08-04-declaring-a-provider-from-the-models-page.md), and [copy-only preset authoring](../simplification/2026-08-08-copy-only-preset-authoring.md) retain their ownership and persistence decisions. This note owns the draft, response-ordering, and dialog interaction rules layered on those mechanisms.

## Alternatives considered

**Disable typing during every save.** This avoids one race but interrupts editing during a slow request and does not preserve drafts across navigation. Capturing the submitted text lets editing continue.

**Keep every Settings section mounted.** This retains component state at the cost of mounting unrelated feature readers. Preserving the instructions controller's draft makes its lifetime explicit without changing section composition.

**Drop refresh requests during a read.** This deduplicates traffic but loses a mutation's invalidation. A serialized rerun bounds concurrent traffic and preserves freshness.

**Use native dialog elements immediately.** Browser focus handling is attractive, but body-portalled menus and other overlays require coordinated top-layer migration. Shared modal behavior preserves the existing overlay layout; `tabbable` handles browser control semantics rather than a handwritten selector list.

## Consequences

Unsaved instructions remain local until Save, and explicit reload still discards them. A stale write response does not change Host persistence or regress the browser mirror. Preset mutation completion includes a fresh roster read, so a slow list response extends the operation's settlement time. Modal and Menu share focus ownership through DOM containment without adding business state or widening plugin exports.

Controller/component regressions cover revision ordering, retained drafts, credential retry, endpoint/proxy inheritance, and overlapping preset refreshes. The keyless [browser scenario](../../../../apps/web/tests/settings-regressions.e2e.ts) exercises real Host writes, nested dismissal, and keyboard navigation with snapshots. The existing Models, settings chrome, Plugins, and preset browser scenarios cover adjacent workflows.
