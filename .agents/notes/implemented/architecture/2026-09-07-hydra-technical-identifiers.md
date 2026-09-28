# Agent Note: Hydra technical identifiers

Status: implemented

## Problem

The CLI, environment, home directory, package.json section, browser destination, boot global, skills, and SDK subagent package need consistent product names. Mixed prefixes make every new path, test, and instruction choose between an obsolete identifier and the current name.

## Decision

Hydra harness uses the identifiers below without legacy aliases, compatibility environment variables, dual home directories, or fallback parsers.

| Role | Identifier |
|---|---|
| CLI bins | `hydra`, `hydra-jsonrpc-agent`, `hydra-acp-demo` |
| Environment namespace | `HYDRA_*`, including `$HYDRA_HOME` and `HYDRA_CLIENT_*` |
| Default home | `~/.hydra` |
| package.json section | `hydra` (`.profile`, `.bundle`, `.client`) |
| In-app browser destination | `hydra` |
| Web boot global | `window.__HYDRA_BOOT__` |
| PTY prompt | `hh>` |
| Test-only globals | `__hh*` |
| Agent skills and gates | `hydra-*` |
| SDK subagent package | `@hydraharness/harness-subagent-sdk`, provider id `hydra-sdk` |
| Obsidian graph root | `Hydra Website Knowledge/` |

[`resolveHydraHome`](2026-07-24-single-harness-home-resolver.md) remains the single home resolver; only its names change. The [repository naming ledger](2026-08-11-repository-naming-contract-and-rename-ledger.md) records `@hydraharness/harness-subagent-sdk`. Frozen archived Agent Notes stay frozen. Vendored Cordis attribution names the original upstream homes (`shigma/cosmokit`, `shigma/schemastery`, `cordiverse/cordis`).

## Alternatives considered

**Keep the obsolete CLI and environment prefix after the display rebrand.** Rejected because contributors and tests would still need a second product name, and the pre-release window makes a compatibility shim more expensive than one rename.

**Use `hh` / `HH_*` / `.hh` as the CLI, environment, and home prefix.** Rejected: those stay `hydra` / `HYDRA_*` / `~/.hydra`. The PTY prompt is `hh>`. Test-only globals use `__hh`. SHA, UUID, and model call ids stay unchanged.

**Keep a separate product name for the browser destination to avoid a CLI name collision.** Rejected: the destination lives in settings, the CLI lives in argv, and the settings label is already `Hydra harness`.

## Consequences

Legacy homes, environment variables, CLI PATH entries, and knowledge-vault roots are not read. A checkout and a user machine must use the current names. Frozen archived Agent Notes may still contain historical identifiers; they are not current authority.
