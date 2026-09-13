# Agent Note: Selective browser observations and file output

Status: implemented

## Problem

Whole-page trailing snapshots and unconditional image delivery spend context on evidence the agent did not request. Suppressing that evidence can leave numeric indexes and diff baselines referring to state the model never saw.

## Decision

Hydra retains its controlled Electron tabs and permission owner while using installed Playwright snapshot distillation for explicit snapshots and text/regex find snippets. Playwright refs remain strings passed through `target`; PageController indexes remain numeric. CSS targets share native locator actionability. The transport refreshes Runtime announcements when attaching Playwright because diagnostics can enable Runtime before its listener exists. Native actions temporarily disable renderer throttling so Playwright stability waits receive animation frames in occluded tabs.

Find and diagnostics return only their result. Configurable snapshot omission keeps internal capture, readiness/dialog evidence, and explicit verification guidance. Hidden, scoped, truncated, saved, or transient observations cannot establish the model's diff baseline. Image omission and filename capture work without an image-capable route or attachment store. Plain filenames select exclusively created private artifact directories, never arbitrary workspace writes; saved text paths remain reconstructable from session events. Diagnostic retention remains bounded and reports truncation. The distilled snapshot masks password values before searching, rendering, or saving it; upstream AI snapshots expose those values.

## Alternatives considered

**Translate Playwright refs into numeric indexes.** Rejected because independent numbering can point at a different control.

**Attach Playwright MCP or CLI to the default Browser.** Rejected because Hydra already owns policy, tab lifecycle, and session logging. CLI plus upstream Skills is reserved for independently requested coding/test automation. Desktop layout remains the default; mobile emulation is not introduced solely for token savings.

**Treat a hidden capture as a diff baseline.** Rejected because later diffs would omit elements the model never received.

**Write filenames directly into the workspace.** Rejected because diagnostic reads must not acquire arbitrary overwrite authority.

## Consequences

Explicit observations let agents trade context volume for additional verification calls. Model-visible screenshot attachments remain durable when delivered as images; file-only evidence has the configured output directory's lifetime. Files do not bypass diagnostic retention limits. Numeric upload, drag, drop, and element-scroll targets retain their existing API.

The [accessibility snapshot decision](2026-09-12-browser-accessibility-snapshot.md), [native Playwright ownership](2026-09-13-native-playwright-controls.md), and [ignored-node projection](2026-09-10-browser-ignored-node-filtering.md) remain active for independent accessibility, security, and numeric-ref guarantees.

## Testing

Focused tool tests cover omission, selector forwarding, invalid inputs, file-only screenshot capture, and unseen diff baselines. Real Electron fixtures verify that observed Playwright refs and CSS selectors act on the intended DOM controls after diagnostics initialization. The runnable ACP browser transcript pins selective output and prompt/schema changes. Packaged desktop and live-site model evaluation remain separate verification lanes.
