# AGENTS.md — Examples

Runnable harness compositions. `examples/` is one workspace member and the module-resolution root for runnable and test Cordis configs; it is not a build target. [package.json](package.json) declares the packages loaded by those configs, while each leaf's private `package.json` remains metadata only.

Extract reusable logic into `packages/`, where per-file coverage and README gates apply. Examples keep only `cordis.yml` wiring, demo artifacts, and e2e/snapshot scenarios; app package bins own boot glue.

## E2E smokes

Each example boots its real `cordis.yml` through the Loader, drives it without provider credentials, and asserts output and clean exit. This catches invalid Loader exports that hand-mounted tests miss ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)). Recorded model scenarios replay keylessly; see [testing.md](../docs/testing.md).

Keyless process smokes use `@hydraharness/harness-loader-smoke` for Loader launch resolution; terminal tests wrap that launch in a pseudo-terminal. Tests supply paths, environment, input, and assertions. Every checked-in test Cordis config lives under its corresponding `examples/<agent>/` leaf. Map a package-owned config to `examples/<agent>/tests/fixtures/<group>/<package>/cordis.yml`, keep its driver and assertions package-local, and declare every package it names in both root `tsconfig.json` references and `examples/package.json`.

Do not inventory example tests here; the `tests/` trees and root scripts are authoritative.

In `cordis.yml`, comment only non-obvious wiring, load-order consequences, replay, security boundaries, and configuration scope. Do not narrate visible entries; use [hydra-prose-standard](../.agents/skills/hydra-prose-standard/SKILL.md) for required coverage and editorial judgment.

See [the root AGENTS.md](../AGENTS.md) for repo-wide conventions and [docs/architecture.md](../docs/architecture.md) for the design.
