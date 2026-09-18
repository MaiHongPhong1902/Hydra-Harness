# Agent Note: GitHub Actions on standard hosted runners

Status: implemented

## Problem

A personal repository cannot allocate another organization's named runner pools. Filtering pushes to master also leaves a default branch named chore/rebrand-hydra without keyless validation. Scheduled live-provider jobs fail before tests when no API secret is configured, while a submodule pinned to an unavailable upstream commit prevents Dependabot from cloning any ecosystem.

## Decision

Primary CI runs on pull requests, pushes to main, master, or chore/rebrand-hydra, and manual dispatch. Every worker and the aggregate verdict accepts all three events. Static archive validation compares the PR base, push predecessor, or dispatched commit respectively when that commit remains reachable; a force-pushed event falls back to the current commit's first parent. Linux workers default to ubuntu-latest and native Windows to windows-latest, with bounded worker counts for standard machines. The existing platform-specific [failover switches](2026-07-26-ci-failover-runbook.md) require provisioned self-hosted runners; optional master standby drills remain separate.

The DeepSeek workflow is manual-only until a repository owner configures DEEPSEEK_API_KEY_EXTERNAL and explicitly restores automatic triggers. Its first step rejects a missing key; a skipped live suite cannot count as validation. This trigger policy supersedes the automatic schedule and trusted-PR policy in the [real-API decision](../testing/2026-06-19-real-api-e2e-ci.md), whose credential isolation still applies. Keyless CI does not consume the secret.

The page-agent submodule uses upstream commit 9eb6b6646500264d9034dd466a4270cb9fc1ef1e (v1.12.4). A parent-repository push must publish an upstream-resolvable gitlink; changing dependency-update exclusions cannot repair a clone that fails before manifest discovery.

Node jobs check out workspace submodules before installing. Knip analyzes the authored Electron preload entry and excludes the upstream PageAgent workspace, whose maintenance belongs to its pinned repository; the desktop's optional Electron binary remains an explicit scoped exemption. The Python deploy filter names the runtime workspace and fails immediately if no workspace matches. Serial Web snapshots leave HYDRA_WEB_SNAPSHOT_WORKERS unset; explicit values select parallel execution and require at least two workers. Coverage uses two single-worker partitions and a 30-second default test budget; explicit fixture deadlines still apply. The missing-turn regression allows 200 milliseconds for its asynchronous log read to produce the expected timeout diagnostic.

Static TypeScript programs resolve registry and personalization imports through source aliases. Existing lib artifacts must not conceal missing aliases on a developer checkout.

## Alternatives considered

Keeping unavailable enterprise labels leaves jobs queued. Silently accepting an empty API key produces a false green. Disabling Dependabot hides dependency updates without repairing fresh clones.

## Consequences

Standard runners may take longer than larger pools. Workflow regressions pin event coverage, runner defaults, and the aggregate verdict; they execute the preflight with absent and placeholder keys. Live-provider coverage requires an explicit dispatch and a real secret. Repositories adopting another default-branch name must update the push branch list.
