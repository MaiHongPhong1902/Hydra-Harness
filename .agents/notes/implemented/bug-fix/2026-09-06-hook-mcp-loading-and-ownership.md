# Agent Note: Hook and MCP loading, ownership, and approval

Status: implemented

## Problem

Imported hooks could be trusted without any executable handlers, and trusted hooks failed during a real turn with `cannot get property "shell" without inject`. Dynamic mounts inherited the context of the service caller. A caller could also own registrations intended to survive as Host state. Imported MCP startup returned before discovery settled; per-tool approval parsed normalized names, so `__` could bypass the default approval decision and lossy names failed to match raw policy keys. Inline MCP declarations also pulled in the default file, and hook-document bounds counted characters instead of UTF-8 bytes.

## Decision

The imported runtime and the user-owned hook and MCP registries capture their construction context for component effects. Callers may request mutations but do not own the resulting registrations or fibers. Imported MCP startup awaits every initial connection outcome, contains failed servers, and reports settled startup state.

Imported MCP policy matches the known server prefix and normalizes stored raw tool names with the bridge's exported `publicToolName`. It never reconstructs a raw identity by splitting the model-facing name. Undeclared server mutations reject before persistence. A manifest MCP declaration overrides discovery of the default `.mcp.json`.

Imported hooks pass the Codex parser before installation or trust; invalid matchers and documents with no supported synchronous command hooks reject. User-owned hook records apply the same runnable-count requirement through their selected dialect parser. Hand-edited invalid records remain isolated from valid siblings. Inline hook budgets count UTF-8 bytes.

The Windows importer translates the four plugin root/data placeholders to PowerShell environment references. Ponytail's shared hook commands use `${CLAUDE_PLUGIN_ROOT}`, which otherwise resolves as an unset PowerShell variable. Keeping path values in the environment avoids interpreting path characters as command source; no general shell translation is attempted.

## Alternatives considered

**Add `shell` to every registry's dependencies.** Rejected because it masks the inherited caller context and leaves component lifetime attached to callers. The bridge already declares its own services.

**Parse or separately normalize MCP public names.** Rejected because punctuation replacement and truncation discard information. The bridge already owns the deterministic forward mapping.

**Accept empty hook projections as successful activation.** Rejected because callers cannot distinguish unsupported definitions from working protection. The dialect parsers remain the authority on the supported subset; this change adds no dialect conversion.

## Consequences

The [imported-plugin lifecycle](../feature/2026-09-01-codex-compatible-imported-plugin-runtime.md), [user-owned records](../feature/2026-09-04-user-owned-mcp-servers-and-hooks.md), and [MCP naming](../feature/2026-07-07-mcp-client-plugin.md) notes remain active for their independent storage, trust, and protocol decisions. This correction narrows their load and effect-ownership behavior.

Focused regressions exercise rejected definitions, raw-name approval, settled startup, and caller disposal. The CLI Loader snapshot runs a local MCP server and real hook processes with a scripted model, comparing request context with durable messages before trust, after trust, after revocation, and after disablement. It also exercises both user-owned hook dialects. No real account or production plugin configuration is required.
