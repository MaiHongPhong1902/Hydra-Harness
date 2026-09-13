# Agent Note: Python runtime wheel for Intel macOS

Status: implemented

## Problem

The Python SDK runtime published Linux and Apple Silicon wheels only, so Intel Macs could not install the bundled runtime.

## Decision

Add a `macos-x64` manifest entry and build it on the Intel `macos-13` runner. The wheel uses the existing macOS sidecar and deployment-target checks, with the same runtime layout as the arm64 wheel.

## Alternatives considered

Keeping arm64-only publication leaves Intel macOS unsupported. A universal binary would require a different native build and packaging path, so the existing per-platform wheel layout is the smallest compatible change.

## Consequences

Release workflows and GitLab publication now expect four runtime wheels plus the SDK wheel. The platform manifest remains the single source for wheel tags and executable names.
