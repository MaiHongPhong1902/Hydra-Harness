# Agent Note: Publish the source desktop guide

Status: implemented

## Problem

The public documentation describes Hydra as a desktop application, but the published guide only explains `npx @hydra/harness web`. Readers cannot find the source command, desktop prerequisites, or the current lack of an installer.

## Decision

The documentation site publishes `docs/user/guide/desktop.md` at `/guide/desktop`. The page documents the source launch sequence, the embedded Web Host, the desktop panels, the Electron data directory, and the current developer-preview limitations. The home page and Web UI guide link to it, while the CLI remains documented with its existing Web command.

## Alternatives considered

**Keep the desktop command only in the root README.** Rejected because the website's user guide is the public entry point and already advertises the desktop surface.

**Document `npx @hydra/harness desktop`.** Rejected because the launcher and published package expose no desktop command or distributable installer.

## Consequences

Readers can reach a runnable desktop setup from the website without mistaking the source launch for an installable desktop release. Future installer or auto-update work needs a separate guide update when those artifacts exist.
