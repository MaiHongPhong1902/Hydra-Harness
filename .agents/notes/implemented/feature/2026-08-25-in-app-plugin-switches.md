# Agent Note: In-app plugin switches

Status: implemented

## Problem

The Plugins inventory showed effective Loader state but required users to leave the app and edit YAML to disable or re-enable an ordinary profile plugin. A switch that disabled its own Settings or RPC path would also be irreversible from the same UI. The Web root also retains disabled placeholders for plugins that agent presets mount in a private realm; treating those placeholders as ordinary switches could move an agent-owned service onto the Host or leave a consumer pending on a provider the same screen disabled.

## Decision

`pluginInventory/setEnabled` changes eligible ordinary root-profile modules through `Entry.update()` and returns a fresh inventory snapshot. The Web inventory card exposes the mutation only when `PluginInventoryEntry.toggleable` is true. Protected core rows, including the Typert path, persist their desired state in the profile manifest and remain loaded until restart; their result and inventory row expose `restartRequired`. The Web bundle config marks the Host gateway, browser transport, module runtime, and Settings rows as protected so a running UI cannot unload its own management path.

The inventory omits disabled Host placeholders from `compositionEntryIds`, then reads the optional `agentPresets` service for the corresponding preset leaf rows. A preset row has an `agent-preset:<preset>:<row>` id, names its preset, and persists through `agent-presets.pluginEnablement`. The Plugins tab groups rows with the same module into one card while retaining each row's switch, because one module can provide several independently configured preset tools. Changing a preset row invalidates only the standing mount used by later sessions, so sessions already running keep their existing composition and the card states that it applies to new sessions.

The Host persists each desired boolean by module name in the shared `plugins.enabled` Settings namespace. Runtime activation or disposal runs before persistence; a failed settings write restores the prior raw `disabled` values. A stored key for a composition-owned module is inert, so a stale switch cannot reactivate its disabled Host placeholder during boot.

## Alternatives considered

**Write the user patch file.** Rejected because an ordinary row needs live `Entry.update()` with rollback when settings persistence fails. The boot-only core map belongs in the profile manifest rather than a generated user layer.

**Apply every switch live.** Rejected because unloading the RPC, module loader, or Settings path can interrupt the UI's own mutation. Nested, grouped, dynamically created, and Host-placeholder rows remain without a switch; protected core rows use the deferred restart path.

**Group workflow provider and consumers into one switch.** Rejected because `tool-workflow` and `tool-ralph` share the engine but remain independent preset choices, and activating their disabled root placeholders would still put agent-owned registrations on the Host. The preset composition already groups each enabled consumer with its provider in the correct realm.

## Consequences

Ordinary profile plugins change immediately and retain that state across restart without replacing profile layers or unrelated settings. Core switches preserve the management path and take effect after restart. Agent-preset tools appear with the preset that owns them and change only later sessions. This decision remains limited to enablement; the separate [Settings plugin marketplaces](2026-08-27-settings-plugin-marketplaces.md) decision adds catalog-driven installation, while removal, update, and generic dependency planning remain deferred.

The focused Host test covers live enablement, protected restart state, preset delegation, shared-settings persistence, and rejection of stale Host placeholders. The preset test proves a changed leaf reaches only a later session. The component test covers the Remote gesture, restart notice, and new-session notice.
