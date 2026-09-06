# Agent Note: GitHub Actions on standard hosted runners

Status: implemented

## Problem

A personal repository cannot allocate another organization's named runner pools. Filtering pushes to master also leaves a default branch named chore/rebrand-bh without keyless validation. Scheduled live-provider jobs fail before tests when no API secret is configured, while a submodule pinned to an unavailable upstream commit prevents Dependabot from cloning any ecosystem.

## Decision

Primary CI runs on pull requests, pushes to main, master, or chore/rebrand-bh, and manual dispatch. Every worker and the aggregate verdict accepts all three events. Static archive validation compares the PR base, push predecessor, or dispatched commit respectively. Linux workers default to ubuntu-latest and native Windows to windows-latest, with bounded worker counts for standard machines. The existing platform-specific [failover switches](2026-07-26-ci-failover-runbook.md) require provisioned self-hosted runners; optional master standby drills remain separate.

The DeepSeek workflow is manual-only until a repository owner configures DEEPSEEK_API_KEY_EXTERNAL and explicitly restores automatic triggers. Its first step rejects a missing key; a skipped live suite cannot count as validation. This trigger policy supersedes the automatic schedule and trusted-PR policy in the [real-API decision](../testing/2026-06-19-real-api-e2e-ci.md), whose credential isolation still applies. Keyless CI does not consume the secret.

The page-agent submodule uses upstream commit 5485e8cffb44a1e3bdf7f58b3e5879b892c2e8dd. A parent-repository push must publish an upstream-resolvable gitlink; changing dependency-update exclusions cannot repair a clone that fails before manifest discovery.

## Alternatives considered

Keeping unavailable enterprise labels leaves jobs queued. Silently accepting an empty API key produces a false green. Disabling Dependabot hides dependency updates without repairing fresh clones.

## Consequences

Standard runners may take longer than larger pools. Workflow regressions pin event coverage, runner defaults, and the aggregate verdict; they execute the preflight with absent and placeholder keys. Live-provider coverage requires an explicit dispatch and a real secret. Repositories adopting another default-branch name must update the push branch list.
