# Agent Note: Keep CI E2E smokes keyless

Status: implemented

## Problem

Credential-dependent E2E cases cannot produce CI evidence on a keyless checkout. Optional secrets also make the same command select different behavior on contributor machines.

## Decision

Automated tests use no external provider keys. Live-only suites and their DeepSeek, E2B, and pi-ai workflows are removed; mixed suites retain their keyless cases. Local HTTP tests, credential-storage tests, real process and browser tests, and recorded model replay remain. Snapshot recording is an explicit fixture-authoring operation and may use credentials.

This supersedes live-test execution in the [real-API policy](../testing/2026-06-19-real-api-e2e-ci.md). That note remains active for its credential-isolation and untrusted-ref rules if external validation is reintroduced. The [portable Actions policy](../process/2026-09-06-portable-github-actions.md) continues to own runner and event selection.

## Alternatives considered

**Keep the cases behind `describe.skipIf`.** Rejected because a skipped case does not validate the behavior and leaves the test inventory coupled to an optional secret.

**Replace live calls with placeholder credentials.** Rejected because a placeholder cannot prove provider behavior and can hide a real network call.

## Consequences

Keyless tests establish integration behavior but do not prove live-provider availability, cache hits, model quality, or external sandbox operation. Reintroducing automated live validation requires an explicit policy change and the credential-isolation rules above. Focused mixed-suite tests and workflow tests verify the retained cases; documentation checks catch references to removed files.
