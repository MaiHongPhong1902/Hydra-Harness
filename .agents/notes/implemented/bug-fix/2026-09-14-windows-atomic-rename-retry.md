# Agent Note: Windows atomic replacement retry

Status: implemented

## Problem

Windows can return `EPERM` while an unrelated reader or scanner still holds the existing settings file during the atomic replacement step.

## Decision

`@hydra/harness-atomic-write` retries only `EPERM` from the final replacement on Windows, with a bounded exponential wait. Writer lock acquisition also retries one unconfirmed Windows `EPERM`, covering the race where the holder releases the lock before the contender's existence check. The existing writer lock remains responsible for application-level writer coordination, and non-Windows or persistent non-`EPERM` failures remain immediate.

## Consequences

Transient file-handle races no longer fail settings persistence; a persistent permission or path failure still reaches the caller after the bounded retry window.
