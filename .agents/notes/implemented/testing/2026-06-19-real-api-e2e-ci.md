# Agent Note: Separate real-API E2E credentials from keyless CI

Status: implemented

## Problem

The default CI gate carries no provider secret and must work for contributors without credentials. Real-API suites self-skip without a key, so adding them to that gate would report success without exercising a model.

## Decision

The [keyless-test policy](../simplification/2026-09-23-remove-keyed-e2e-smokes.md) supersedes live-suite execution. The following credential-isolation constraints remain required if live automation is reintroduced.

A live run must reject an empty key before checkout or build, rather than treating skipped tests as validation. Scope secrets to preflight and provider calls; checkout, installation, and build receive none. Print presence only, never values or lengths, and pin the intended provider endpoint.

Never run untrusted PR code through `pull_request_target`. Fork and Dependabot runs do not gain secret eligibility from a maintainer rerun. Repository writers control secret-consuming workflows, so membership and ref selection remain access controls.

## Alternatives considered

Combining live tests with keyless CI couples contributor checks to credentials. Omitting preflight lets missing credentials report success through skipped tests. Running live tests automatically without a configured key creates recurring failures that provide no provider evidence.

## Consequences

Keyless checks do not prove live-provider behavior. A future live result would prove only the selected ref and configured provider at that run. Native search response parsing remains deterministic coverage, not evidence that an external endpoint supplies structured source blocks.
