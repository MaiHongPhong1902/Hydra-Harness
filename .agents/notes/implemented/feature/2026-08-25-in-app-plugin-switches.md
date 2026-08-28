# Agent Note: In-app plugin switches

Status: implemented

## Problem

The Plugins inventory showed effective Loader state but required users to leave the app and edit YAML to disable or re-enable an ordinary profile plugin. A switch that disabled its own Settings or RPC path would also be irreversible from the same UI. The Web root also retains disabled placeholders for plugins that agent presets mount in a private realm; treating those placeholders as ordinary switches could move an agent-owned service onto the Host or leave a consumer pending on a provider the same screen disabled.

## Decision

`pluginInventory/setEnabled` changes eligible root-profile modules through `Entry.update()` and returns a fresh inventory snapshot. The Web inventory card exposes the mutation only when `PluginInventoryEntry.toggleable` is true; the Web bundle config protects the Host gateway, browser transport, module runtime, and Settings rows that keep this path usable. Its `compositionEntryIds` list omits the disabled root placeholders and matching preset rows from both inventory projection and module-wide mutation, leaving their plane and enablement to the selected agent preset.

The Host persists each desired boolean by module name in the shared `plugins.enabled` Settings namespace. Runtime activation or disposal runs before persistence; a failed settings write restores the prior raw `disabled` values. A stored key for a composition-owned module is inert, so a stale switch cannot reactivate its disabled Host placeholder during boot.

## Alternatives considered

**Write the profile patch.** Rejected because enablement is a shared user preference across Web and Desktop, while profile entry ids and layer positions are deployment details. Module-name settings preserve the profile composition and let the Host roll live entries back when persistence fails.

**Allow every inventory row to toggle.** Rejected because disabling the RPC, module loader, or Settings rows would persist a state the same UI could not reverse. Nested, grouped, dynamically created, and protected entries remain visible without a switch.

**Group workflow provider and consumers into one switch.** Rejected because `tool-workflow` and `tool-ralph` share the engine but remain independent preset choices, and activating their disabled root placeholders would still put agent-owned registrations on the Host. The preset composition already groups each enabled consumer with its provider in the correct realm.

## Consequences

Ordinary profile plugins change immediately and retain that state across restart without replacing profile layers or unrelated settings. Agent-preset tools no longer appear as Host plugin switches; users change that toolset through the preset that owns it. This decision remains limited to enablement; the separate [Settings plugin marketplaces](2026-08-27-settings-plugin-marketplaces.md) decision adds catalog-driven installation, while removal, update, and generic dependency planning remain deferred.

The focused Host test covers live disable/enable, protected rows, shared-settings persistence, and rejection of stale switches for composition-owned rows. The component test covers the Remote gesture and returned snapshot, while the keyless Web Settings scenario exercises the assembled Host-to-browser path and captures the expanded control.
