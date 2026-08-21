# Agent Note: One harness home resolver

Status: implemented

## Problem

The harness had two inconsistent conventions for "where does Bosch Harness user data live":

- `@bosch/bh-home` resolved `configured ?? $BH_HOME ?? ~/.bh`.
- `@bosch/bh-home-paths` shipped a **second** `resolveBhHome` with the same precedence plus tilde expansion — a near-duplicate of `bh-home` that no gate flagged because the two lived in different packages and had already drifted (only one expanded tildes).

Two resolvers for the same cross-cutting fact meant there was no single home policy.

## Decision

One resolver owns the harness home, in `@bosch/bh-home-paths`, single-root:

```
explicit configured path  >  $BH_HOME  >  ~/.bh
```

An empty or whitespace-only `$BH_HOME` is treated as unset; otherwise `resolve('')` would silently place the home at the current working directory. The harness keeps all user data under one root; there is no XDG config/data/cache split. `bhHomePath(...segments)` joins deployment-owned children onto that root, and `bh-app-boot` exposes it to Loader `!!js` config expressions before mounting entries, so shipped compositions derive `sessions` and `storages` without copying the resolver. `bhHomeDisplay()` names a resolved root symbolically for user-facing paths — `~/.bh` for the default home, `$BH_HOME` for any configured home — so the user-global `AGENTS.md` label never leaks an absolute machine path. It replaces agent-instructions's bespoke default-vs-`$BH_HOME` check.

`@bosch/bh-home` is deleted. Its three importers (`bh-tool-bash`, `bh-skill-filesystem`, `bh-agent-spine-demo`) import `resolveBhHome` from `bh-home-paths`.

`bh-telemetry` and its separate home policy are absent under the [SDK project toolchain removal](../simplification/2026-08-11-remove-sdk-project-toolchain.md), leaving this resolver as the sole home policy.

## Alternatives considered

**Leave the two `resolveBhHome` copies in place.** They had already drifted (one expands tildes, one didn't) and encode the same cross-cutting fact twice. Consolidation is the point of the `util/` layer; a duplicate resolver is a latent divergence bug.

**Adopt XDG (honor `$XDG_CONFIG_HOME`, or split config/data/cache into separate trees).** Considered and dropped in favor of one obvious root. A single `$BH_HOME || ~/.bh` ground truth matches `~/.claude` / `~/.aws`, needs no per-kind reclassification of every `~/.bh` consumer, and leaves no resolver asymmetry to reconcile.

## Consequences

- One home fact, one resolver. `bh-home-paths` is the sole owner; the `util/` group loses the `home` package.
