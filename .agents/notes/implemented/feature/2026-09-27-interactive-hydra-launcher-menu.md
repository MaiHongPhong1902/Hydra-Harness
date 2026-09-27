# Agent Note: Interactive Hydra launcher menu

Status: implemented

## Problem

The published `@hydra/harness` executable required an explicit profile or `web` alias, so a user invoking the package without arguments received a profile error instead of a unified entry point. Desktop is discoverable as a product surface but remains source-checkout-only and cannot safely be presented as an npm launch mode.

## Decision

A bare `hydra` invocation resolves to an interactive, line-oriented menu when stdin and stdout are TTYs and `CI` is not set. The menu offers Web, Headless, and Desktop. Web and Headless construct the existing profile dispatch directly; Headless prompts for one task without reparsing it as a launcher subcommand. Desktop prints the source-checkout workflow and exits without starting Electron. Explicit `web`, `--profile`, `plugin`, config-dump, help, and version invocations keep their existing parser and dispatch paths. Bare invocations without an interactive terminal return status 1 with explicit Web and Headless commands instead of waiting or selecting a long-running profile implicitly.

## Alternatives considered

**Default every bare invocation to Web:** Rejected because a pipe or CI job could unexpectedly start a long-running server and hang. The menu keeps the choice explicit for interactive users and requires script-safe commands elsewhere.

**Launch Desktop from the menu:** Rejected because the published package has no supported Electron artifact, installer, native dependency acceptance, or Desktop release smoke. The menu points to the documented source workflow without making a false npm promise.

**Use raw terminal arrow-key navigation or a prompt dependency:** Rejected in favor of Node's line-oriented `readline`, which works across Windows and POSIX terminals, is easy to inject in tests, and does not add a runtime dependency.

## Consequences

The package now has one discoverable interactive entry point while existing automation remains stable through explicit commands. Desktop is visible in the menu but still requires a source checkout, `pnpm install`, a build, and `pnpm run desktop`. Packed-install verification checks the non-interactive fallback but intentionally does not claim Desktop support.

## Testing

Parser and menu unit tests cover Web, Headless task preservation, blank tasks, Desktop guidance, quit/EOF, and non-TTY/CI behavior. Source-launch and built-bin tests cover the non-interactive fallback, and release smoke checks the same behavior after packed installation. Documentation and Markdown wrapping checks cover the updated user-facing command contract.
