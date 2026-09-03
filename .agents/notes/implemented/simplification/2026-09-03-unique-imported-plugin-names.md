# Agent Note: Unique imported plugin names

Status: implemented

## Problem

Source-qualified identities allowed two local, Git, or marketplace sources to install the same plugin manifest name concurrently. The records were safe at rest, but the Settings list presented duplicate names and short-name commands became ambiguous even though users treat a plugin name as its identity.

## Decision

`PluginStore.install()` rejects an import when another installed identity already has the staged manifest name. The check reads the registry under its existing file lock, so concurrent imports cannot both commit. Reimporting the same source-qualified identity remains an update, and removing the current record releases the name for another source.

The Plugins tab keeps the existing remove action. Import failure copy names an installed duplicate as one possible correction without exposing source paths or Host diagnostics.

## Alternatives considered

**Keep same-name records and require source-qualified commands.** Rejected because it preserves a flexibility the product does not need while leaving duplicate cards and ambiguous short-name actions in the normal path.

**Check the displayed list before importing.** Rejected because UI and command callers can bypass it, and two processes can pass a preflight check before either writes. The registry lock is the operation that owns uniqueness.

## Consequences

One imported plugin name maps to at most one installed record. Forks with the same manifest name cannot run side by side; a user removes the current record before switching sources. The runtime test covers rejection without a second registry entry and successful import after removal.
