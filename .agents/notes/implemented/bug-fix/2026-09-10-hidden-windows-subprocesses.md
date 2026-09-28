# Agent Note: Hidden Windows subprocesses

Status: implemented

## Problem

A desktop host without a console (such as an Electron desktop host) creates an external visible console window for each shell command, runner child, and cleanup helper when spawned without window suppression. In addition, spawning `process.execPath` inside an Electron utilityProcess without `ELECTRON_RUN_AS_NODE: '1'` boots the full Chromium GUI runtime instead of Node CLI, adding tens of seconds of latency.

## Decision

1. The local subprocess provider sets Node's `windowsHide: true` option for ordinary commands and both `taskkill` paths.
2. In the Windows ACL sandbox (`@hydraharness/harness-sandbox-windows-acl`), `createProcessAsUserW` sets `STARTF_USESHOWWINDOW` in `STARTUPINFOW.dwFlags` and `wShowWindow: SW_HIDE` (0) for both `spawnSandboxed` and `spawnSandboxedInherited`. This suppresses console window creation under restricted tokens without triggering the `STATUS_DLL_INIT_FAILED` (0xC0000142) error caused by `CREATE_NO_WINDOW`.
3. When running under Electron (`process.versions.electron !== undefined`), `ELECTRON_RUN_AS_NODE: '1'` is injected into the child environment so `process.execPath` executes as a pure Node CLI process.
4. In `apps/desktop/main.cjs`, `startTerminal` prefers PowerShell 7 (`pwsh.exe`) when available before falling back to Windows PowerShell 5.1.

## Alternatives considered

**Use `CREATE_NO_WINDOW` in `dwCreationFlags` for `CreateProcessAsUserW`.** Restricted tokens reject `CREATE_NO_WINDOW` during CSRSS / console initialization with `STATUS_DLL_INIT_FAILED`. `STARTF_USESHOWWINDOW` with `SW_HIDE` succeeds reliably while keeping the window hidden.

**Reuse one PowerShell process for ordinary commands.** Persistent state changes command isolation and cancellation semantics. Avoiding console allocation and GUI boot overhead removes latency without altering execution isolation.

## Consequences

Piped subprocesses and ACL sandboxed children run with hidden windows and fast Node startup across desktop and CLI execution. The Windows regression suites verify both unrestricted and restricted-token child spawns with zero visible consoles.
