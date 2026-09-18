# Agent Note: answer PowerShell PTY cursor queries before bootstrap

Status: implemented

## Problem

PowerShell on POSIX loads PSReadLine in a node-pty session and emits the terminal cursor-position query `ESC[6n` before it accepts input. The persistent terminal backend did not emulate that terminal response, so the first prompt setup could be consumed as an incomplete PSReadLine interaction and real PowerShell PTY and Loader tests timed out or exited during startup.

## Decision

The PTY session recognizes complete and split `ESC[6n` sequences and responds with the valid origin position `ESC[1;1R`. For a PowerShell session, the first write waits for initial output with no incomplete query suffix. The wait also ends when the send settles, and send ownership is checked before writing. Cancellation, timeout, or closure cannot release a stale bootstrap write. The response parser remains local to the PTY session and does not expose terminal control bytes to retained output. This extends the [persistent PowerShell startup mechanism](../architecture/2026-08-11-pwsh-persistent-pty.md) without changing its prompt-readiness rules.

## Alternatives considered

**Add a headless terminal emulator.** Rejected because the backend only needs one device-status response and a full emulator adds a dependency and lifecycle surface without fixing the ordering requirement.

**Queue a cursor response immediately at session creation.** Rejected because PSReadLine echoes a response sent before its query and corrupts the bootstrap line.

**Skip POSIX PowerShell PTY tests.** Rejected because the runtime supports this path and the failure is a missing terminal response, not an unsupported platform.

## Verification

Session unit tests cover split and multiple queries, bootstrap ordering, cancellation, timeout, closure, and cursor-response write failures. The Linux real-shell and Loader compositions exercise UTF-8 output and persistent cwd/environment behavior with a real PowerShell executable.

## Consequences

Persistent PowerShell PTY startup is compatible with PSReadLine on POSIX while bash and later sends retain their existing readiness behavior. Only the first PowerShell write waits for initial output; a terminal that exits or fails resolves that wait and follows the existing session error path.
