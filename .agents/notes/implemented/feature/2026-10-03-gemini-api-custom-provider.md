# Agent Note: Gemini API custom-provider onboarding

Status: implemented

## Problem

Putting Gemini API beside Antigravity in Google sign-in makes separately billed API access appear to use a consumer Google AI plan. The API OAuth method also requests a quota project, which does not belong to the Antigravity sign-in path.

## Decision

New Gemini API connections use the custom-provider form in API keys. A template fills editable identity, endpoint, and native Gemini protocol fields when the adapter advertises that protocol. The existing custom-provider mutation, credential storage, and model discovery own creation; the template stores no models or keys itself. Duplicate route IDs remain a form error, so users can choose another ID without overwriting a provider. Switching to Custom retains the draft for manual editing.

Google sign-in connects Antigravity. The [Gemini web removal decision](../simplification/2026-10-04-remove-gemini-web.md) owns the consumer-session exclusion. Saved Gemini API OAuth profiles remain editable and removable in API keys with their existing credentials and project settings. They are excluded from new-provider selectors. The template neither creates a shared Google account nor configures an Antigravity counterpart.

## Alternatives considered

**Create API profiles through Google OAuth.** Rejected because the consumer sign-in grouping obscures API billing and project requirements.

**Convert saved OAuth profiles to API keys.** Rejected because an OAuth grant cannot supply an API key. Existing credentials and model catalogs require explicit user replacement.

## Consequences

The custom route uses the pi-ai native Gemini adapter for its supported chat, image, and video models. Model discovery reflects API access rather than Google AI subscription access. Keyless UI tests and an assembled browser journey verify template selection, API-key storage, discovery, editable fields, deletion, and separation from Google sign-in; live API entitlements remain provider-dependent.
