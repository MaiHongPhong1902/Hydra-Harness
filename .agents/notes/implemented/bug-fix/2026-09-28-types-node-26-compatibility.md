# Agent Note: Keep Node type upgrades compatible with existing fetch and IPC code

Status: implemented

## Problem

The Node 26 type upgrade exposed three existing assumptions: undici and global fetch response types no longer cast directly, process.disconnect is optional, and the mocked stat result may be undefined.

## Decision

Keep runtime behavior unchanged while narrowing the optional IPC call, guarding the mock result, and using an explicit unknown bridge for the intentional undici to global fetch type adaptation.

## Consequences

The Node type upgrade can pass the host build and test typecheck without weakening runtime checks or changing proxy, dialog, or persistence behavior.

## Alternatives considered

Reverting the Dependabot update would keep the old type assumptions hidden and leave the repository unable to consume the current Node declarations.

## Verification

The focused issue-management tests and local pre-push build/typecheck pass; the rebased Node type pull request reruns the full repository checks.
