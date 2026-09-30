# Agent Note: Review dependency updates manually

Status: implemented

## Problem

Maintained dependencies need updates, but a manifest-only major upgrade can break consumers that require coordinated API changes. Automatic proposals for React/Vite, YAML schemas, and HTTP dispatchers require substantial diagnosis before acceptance. A release-age cooldown reduces early-release exposure without establishing compatibility with Hydra.

## Decision

The [GitHub configuration](../../../../.github/) contains no Dependabot version-update schedule. Maintainers prepare dependency updates with the pinned package manager and shared lockfile, inspect affected consumers, and run the [relevant checks](../../../../AGENTS.md#run-relevant-checks-locally) before acceptance. Vendored Cordis dependencies follow the [vendoring procedure](../../../../vendor/README.md); the [Landlock release decision](2026-08-06-in-repository-landlock-release.md) owns the native package's shared-workspace membership.

Dependabot security updates and vulnerability alerts are independent administrator-controlled repository settings. Removing the version-update configuration does not disable security-update pull requests. The CI exclusions that keep Dependabot code off persistent self-hosted runners remain security controls, and the external-reference parser remains useful for human and automated release-note links.

Reintroducing update automation requires an explicit maintainer decision. Its baseline is a uniform 30-day version-release cooldown without coordinated-release exemptions, root-workspace ownership including native packages, vendored-path exclusions, and support for the pinned pnpm 11 and lockfile format 9 rather than an updater-only downgrade. The provider-run update job establishes updater compatibility. The Python SDK uv project and GitHub Actions require their own configured ecosystems; a separate native npm scan would split one lockfile's ownership.

Automated proposals retain maintainer review, normal CI, and the `kind/dependency` and `area/infra` labels. Security updates bypass the version cooldown, but unrelated fresh transitives must wait or be narrowed rather than weakening release-age checks. A security proposal affecting vendored manifests is replaced through the vendoring procedure. Explicitly reviewed manual updates can follow their owning coordinated-release procedures.

## Alternatives considered

**Keep Dependabot with a cooldown.** A cooldown quarantines fresh releases and regular proposals reduce manual discovery, but neither benefit resolves incompatible major upgrades. Manual review owns update preparation as well as acceptance.

**Merge updates automatically after CI.** Dependency changes can alter runtime, build, and release behavior; passing checks does not replace the compatibility decision.

**Use Renovate or a scheduled agent.** Another proposal service retains the same diagnosis and coordination work. It adds automation without resolving the observed compatibility failures.

**Adopt releases immediately or exempt coordinated releases from cooldowns.** These choices remove the uniform automated quarantine. Coordinated fresh releases require an explicit synchronization decision through the manual path.

## Consequences

Scheduled version-update pull requests and their CI workload stop. Maintainers take responsibility for discovering and preparing updates. Existing pull requests remain reviewable, repository security settings require separate administrator access, and removing automation leaves the runner isolation and vendoring rules intact.
