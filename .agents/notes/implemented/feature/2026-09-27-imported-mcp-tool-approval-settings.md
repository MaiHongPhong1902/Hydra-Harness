# Agent Note: Imported MCP tool approval in Settings

Status: implemented

## Problem

Imported plugin bundles can expose MCP tools with different trust levels, but a Settings user previously had only a server-wide enable switch while the runtime already enforced `ask`, `allow`, and `deny` per tool. The missing Settings control forced users to accept the default prompt policy or change an unsupported runtime state through another surface.

## Decision

The Plugins → MCP tab lists every discovered public tool for an imported MCP server and renders an `ask`/`allow`/`deny` select for each tool. Changes stay loopback-only and call `pluginInventory.setPluginMcpToolApproval` alongside the existing server enablement Remote. The Host Remote delegates to `ImportedPluginRuntime.setMcpToolApproval`, and the connection privileged-method allowlist pins it to the local desktop boundary.

The runtime accepts either a raw MCP tool name or the displayed host-qualified public name when storing an override. Enforcement matches both forms, so normalized or hashed public names remain actionable from the UI without exposing a second raw-name catalog. A tool with no override continues to use its server's `defaultToolsApprovalMode`, which defaults to `ask` for a newly discovered server. Failed approval writes retain the current snapshot, show the existing MCP mutation alert, and trigger a best-effort refresh for retry.

## Alternatives considered

**Expose only a free-form raw-tool text field.** Rejected: users would have to infer the MCP wire name and could not safely map it to the tool displayed by the model. The public-name setter accepts the exact name shown in Settings.

**Change only the server default approval mode.** Rejected: one default cannot express a safer policy for a destructive tool beside read-only tools. Per-tool overrides are already enforced by the runtime and preserve the server default for untouched tools.

**Add a second approval subsystem in the browser.** Rejected: approval is a Host runtime policy. Settings remains a projection and mutation client; execution continues to consult the Host-owned policy before every MCP call.

## Consequences

Imported MCP configuration now has an explicit review path from server enablement to individual tool approval, while remote browsers still receive no process or policy controls. Public-name overrides are retained in the existing `toolApproval` map and are checked alongside raw names, so future runtime migrations must preserve both matching forms. Focused runtime, Remote, connection-fence, client-apply, and browser component tests cover the setter and denial path.
