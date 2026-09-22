# Agent Note: Pinned Bubblewrap payloads use Ubuntu Snapshot

Status: implemented

## Problem

Linux CI prepares Bubblewrap by downloading a versioned Ubuntu package while dependencies install. The live archive can remove that package while the pinned version and checksum remain valid, which makes every job that overlaps this preparation fail with curl status 22.

## Decision

[The Bubblewrap preparation script](../../../../scripts/prepare-ci-bubblewrap.sh) downloads the pinned `0.9.0-1ubuntu0.1` amd64 package from Ubuntu Snapshot at `20260722T000000Z`. The existing SHA-256 verification, extraction into `RUNNER_TEMP`, PATH publication, and functional confinement probe remain unchanged. The [CI workflow test](../../../../scripts/ci-workflow.spec.ts) pins the Snapshot source and rejects the live archive URL.

## Alternatives considered

**Track the live Ubuntu archive.** Rejected because archive retention is not stable for a versioned package and a 404 stops every dependent Linux job before its own checks run.

**Install Bubblewrap through apt.** Rejected for the [existing package-transaction cost](2026-07-22-evidence-based-larger-hosted-runners.md#alternatives-considered); the verified extracted payload already supplies the required executable.

## Consequences

The archive remains available at the selected Snapshot timestamp while the checksum protects against payload replacement. Updating Bubblewrap requires choosing a new Snapshot timestamp, version, and checksum together, then running the script and workflow tests.
