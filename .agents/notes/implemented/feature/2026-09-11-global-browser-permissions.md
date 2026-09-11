# Agent Note: Global Browser action permissions

Status: implemented

## Problem

Website access rules cannot express whether an agent may read a page, download a file, or upload a local file across all websites. A settings control without a matching runtime check leaves those capabilities unrestricted.

## Decision

Settings → Browser exposes one Browser permissions card with Browsing, Downloads, and Uploads in three desktop columns. The existing `browser-electron` settings namespace stores `browserPermissions` with independent `allow`, `ask`, or `block` decisions. An absent object inherits the saved legacy policies; invalid members use `ask`. Existing defaults remain `ask` for all three capabilities.

The Host browser service checks normal actions and reads before execution, applies Uploads before file selection, and routes native download decisions through the existing approval service. A one-time approval changes no setting and creates no site rule. Live settings updates reach existing controllers, and revocation is rechecked after approval and asynchronous preparation. Native download approval pauses the item until the owner answers; document replacement, cancellation, and a missing answerer deny it. Explicit navigation carries approval for its exact URL only, so a redirect to another destination still checks native policy.

This partially supersedes [Browser website permissions in chat](2026-09-07-browser-permissions-in-chat.md): browsing and downloads use execution approvals, while media keeps its existing question flow. [Desktop browser settings](2026-08-26-desktop-browser-settings.md) still owns managers, legacy defaults, link routing, and sensitive history/CDP controls.

## Alternatives considered

**Require an entry for each website.** That cannot express independent global file-transfer permissions and makes initial Browser Use depend on site configuration.

**Add another settings store or approval UI.** The existing Host settings provider and approval service already persist decisions and connect them to the owning conversation.

**Change established defaults during migration.** Retaining legacy policies preserves saved user choices; the global object takes precedence once the user saves it.

## Consequences

Browsing permission never authorizes a download or local file selection. Uploads accept task-created artifacts without requiring the user to repeat their paths; readable-file validation and approval bind the transfer to the intended file and destination. Hidden HTML file inputs remain addressable, while disabled or disconnected inputs reject selection. Sensitive-history permission and Full CDP opt-in remain additional checks. Existing website blocks remain restrictive exceptions. An approval requires an open owning turn; an unowned or finished conversation cannot authorize a delayed download.

Official service tests exercise the capability/mode matrix and independent blocking; settings tests cover legacy inheritance and invalid values. Client checks cover the three options, one permission heading, and durable writes. Native download timing, asynchronous PageAgent revocation, and the assembled approval transcript require runtime verification in addition to these focused tests.
