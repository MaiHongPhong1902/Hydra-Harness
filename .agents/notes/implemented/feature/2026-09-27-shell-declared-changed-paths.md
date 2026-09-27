# Agent Note: Shell calls can declare changed paths for instruction refresh

Status: implemented

## Problem

Workspace instructions refreshed after `read`, `write`, and `edit` calls, but an opaque `bash` or `pwsh` command could not identify files it changed.

## Decision

Add an optional `changed_paths` array to both shell tools. The caller declares paths explicitly; after a successful foreground result, `agent-instructions` reads the validated arguments directly, resolves relative entries against the effective shell workdir (or session cwd), preserves each path string, and projects the entries into the next workspace-context refresh. Failed, aborted, and background calls do not publish a refresh hint, and no presentation metadata carries these paths.

## Alternatives considered

**Parse shell text.** Redirects, variables, pipelines, scripts, and child processes make inferred paths unreliable.

**Create reversible fs-review records.** Result metadata arrives after execution, so it cannot capture pre-execution bytes. A structured mutation API or executor-owned before/after snapshots are required for that feature.

## Consequences

Models must name every changed file when a shell command should refresh scoped instructions. The declared paths are context-refresh hints only; they are not observed changes, an authoritative mutation log, or a reversible review record. Nested dispatches inherit successful foreground hints through their execution parent; an outer failure does not erase a completed nested result.
