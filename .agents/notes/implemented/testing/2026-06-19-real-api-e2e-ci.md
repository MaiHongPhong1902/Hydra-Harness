# Agent Note: Separate real-API E2E credentials from keyless CI

Status: implemented

## Problem

The default CI gate carries no provider secret and must work for contributors without credentials. Real-API suites self-skip without a key, so adding them to that gate would report success without exercising a model.

## Decision

[The DeepSeek workflow](../../../../.github/workflows/e2e.yml) runs the full real-API suite separately from keyless CI. The [portable Actions policy](../process/2026-09-06-portable-github-actions.md) owns its manual-only trigger while this repository lacks a provider key; it supersedes the automatic schedule and trusted-PR trigger policy. Dispatch requires a writer to choose the code ref and configure DEEPSEEK_API_KEY_EXTERNAL. Restoring automatic runs requires an explicit workflow change after configuring that secret.

The first step rejects an empty key with exit 1 and names the required secret. This prevents a self-skipped suite from masquerading as successful live validation, and avoids installing dependencies or building when the run cannot proceed.

The secret maps to DEEPSEEK_API_KEY only in preflight and the test step. Checkout, setup, dependency installation, and build receive no provider key. Preflight prints presence only, never the value or length. The test step pins DEEPSEEK_BASE_URL to https://api.deepseek.com. The workflow has contents: read permission, builds official artifacts, and runs the example bins from lib under Node 24 with bounded workers and a job timeout.

The workflow must never run untrusted PR code through pull_request_target. GitHub withholds secrets from ordinary fork and Dependabot pull_request events; a maintainer rerunning a Dependabot PR does not change its author or credential eligibility. Any future PR trigger must preserve those distinctions. Repository writers can author secret-consuming workflows, so membership and ref selection remain part of credential access control. Making a repository public also makes logs public; secret values must remain absent from logs.

## Alternatives considered

Combining live tests with keyless CI couples contributor checks to credentials. Omitting preflight lets missing credentials report success through skipped tests. Running live tests automatically without a configured key creates recurring failures that provide no provider evidence.

## Consequences

Keyless checks and real-provider validation report independently. A manual E2E result proves only the selected ref and configured provider at that run; no scheduled or pre-merge live signal exists under the manual policy. The native web_search probe remains skipped because a successful endpoint response does not reliably contain structured source blocks; unit parsing checks do not establish that live behavior.
