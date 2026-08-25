# Agent Note: In-app plugin switches

Status: implemented

## Problem

The Plugins inventory showed effective Loader state but required users to leave the app and edit YAML to disable or re-enable an ordinary profile plugin. A switch that disabled its own Settings or RPC path would also be irreversible from the same UI.

## Decision

`pluginInventory/setEnabled` changes eligible root-profile entries through `Entry.update()` and returns a fresh inventory snapshot. The Web inventory card exposes the mutation only when `PluginInventoryEntry.toggleable` is true; the Web bundle config protects the Host gateway, browser transport, module runtime, and Settings rows that keep this path usable.

The Host persists each desired boolean in a marker-delimited block inside the active profile's `cordis.patch.yml`. It validates the complete patch document with the Include YAML schema, preserves every line outside the managed block, serializes writers with `withFileLock`, and commits through `writeFileAtomic`. Runtime activation or disposal runs before persistence; a failed write restores the prior raw `disabled` value.

## Alternatives considered

**Write the composed root `cordis.yml`.** Rejected because the profile root is intentionally empty and the root Include carries bundle and user layers in memory; serializing the composed tree would flatten ownership and overwrite configuration provenance.

**Allow every inventory row to toggle.** Rejected because disabling the RPC, module loader, or Settings rows would persist a state the same UI could not reverse. Nested, grouped, dynamically created, and protected entries remain visible without a switch.

**Store switches in a separate settings document.** Rejected because startup would briefly activate disabled plugins and would duplicate the existing Loader patch mechanism.

## Consequences

Ordinary profile plugins change immediately and retain that state across restart without replacing user comments or unrelated patches. The profile layer remains subject to the documented composition order, so a later home-level or command-line overlay can still win. The capability changes enablement only; installation, removal, update, provenance, and dependency planning remain outside this package.

The focused Host test covers live disable/enable, protected rows, marker stability, and exact YAML persistence. The component test covers the Remote gesture and returned snapshot, while the keyless Web Settings scenario exercises the assembled Host-to-browser path and captures the expanded control.
