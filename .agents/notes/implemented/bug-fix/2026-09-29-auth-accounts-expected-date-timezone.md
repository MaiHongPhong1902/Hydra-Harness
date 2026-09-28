# Agent Note: `auth-accounts` reset-date goldens were authored in a non-UTC timezone

Status: implemented

## Problem

`apps/web/tests/auth-accounts.e2e.ts` failed on hosted CI (and in a from-scratch Linux container) with a one-day mismatch on two "Weekly usage limit Resets …" lines, while every other date/time on the same screen matched. `ProviderAccounts.tsx`'s `resetLabel` renders `new Date(resetsAt * 1000).toLocaleString()` with no explicit timezone, so the rendered calendar date depends on the browser process's host timezone. `account-auth-fixture.ts`'s `resetsAt` values are fixed Unix instants (e.g. `1_801_000_000`), not relative to "now", so the mismatch was never about clock drift — it was two different fixed timezones disagreeing about which calendar day a specific instant near local midnight falls on.

Computed directly: `1_801_000_000` is `2027-01-26T21:46:40Z`. In UTC that's still the 26th; in the timezone the goldens were authored under (UTC+7), the same instant is already `2027-01-27T04:46:40` local — hence the committed `1/27/2027`. Hosted CI's `ubuntu-latest` runners (and this repo's Linux container image) default to UTC, so they always compute `1/26/2027`. A second, not-yet-observed instance of the same class existed in `google.expected.md` (`1_800_120_000` → `2027-01-16T17:20:00Z`, UTC day 16, authored-timezone day 17).

## Decision

**Correct both goldens to the UTC value** (`connected.expected.md`'s bob weekly reset to `1/26/2027`; `google.expected.md`'s Claude weekly reset to `1/16/2027`), since UTC is what the hosted CI runners that gate merges actually produce, whatever timezone an individual contributor's machine happens to run in.

## Consequences

Confirmed via `TZ=UTC` inside the Linux container (matching hosted CI): both `auth-accounts.e2e.ts` tests pass. Any future `resetsAt` fixture value must be checked the same way — compute its UTC calendar date directly rather than trusting whatever a local dev machine's browser renders, since only a UTC-timezone environment (hosted CI) is authoritative for these goldens. `resetLabel`'s use of the host timezone is itself correct product behavior (real users want their own local reset time), so this is a test-authoring gap, not a product bug.

## Alternatives considered

**Pinning the test browser's timezone to UTC** (e.g. a Playwright context `timezoneId` option) so goldens are reproducible on any contributor's machine, not just CI. Not done here: it would touch shared page-launch helpers used by many other specs, and this specific class of failure (a `resetsAt` instant landing within a few hours of local midnight) is rare enough that fixing the two known instances unblocks CI without that broader, higher-blast-radius change.

## Verification

`docker exec -w /repo hh-ci sh -c "pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/auth-accounts.e2e.ts"` — both tests pass with the container's default UTC timezone, and also pass when `TZ=UTC` is set explicitly.
