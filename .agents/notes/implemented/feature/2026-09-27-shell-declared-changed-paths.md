# Agent Note: Shell calls can declare changed paths for instruction refresh

Status: implemented

## Problem

Workspace instructions refreshed after `read`, `write`, and `edit` calls, but an opaque `bash` or `pwsh` command could not identify files it changed.

## Decision

Add an optional `changed_paths` array to both foreground shell tools. The caller declares paths explicitly; successful foreground results persist the trimmed paths in presentation metadata, and `agent-instructions` projects them into the next workspace-context refresh. Failed, aborted, and background calls do not publish the metadata.

## Alternatives considered

**Parse shell text.** Redirects, variables, pipelines, scripts, and child processes make inferred paths unreliable.

**Create reversible fs-review records.** Result metadata arrives after execution, so it cannot capture pre-execution bytes. A structured mutation API or executor-owned before/after snapshots are required for that feature.

## Consequences

Models must name every changed file when a shell command should refresh scoped instructions. The metadata is a context-refresh hint only; it is not an authoritative mutation log or reversible review record.
