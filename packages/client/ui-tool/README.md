# @hydraharness/harness-client-ui-tool

Client Tool presentation plugin. `ui-conversation` dispatches each ordered `tool-call` Conversation Node through the matching key of `conversation.chat.node`; this package renders its root and Code Dispatch children, then dispatches every atomic call through the keyed `tool.call.toolview` slot. Unregistered Tool names use the generic card.

`card: 'media'` call/result intents become separate `media-generation` Chat Nodes. They remain outside activity disclosures and use one image/video treatment: authored prompt, animated pending preview, completion or failure, actual model, and a generation-details action. Reduced-motion preferences disable the placeholder animation. Images use the existing attachment gallery; MP4/WebM references use native video controls and download without autoplay. Reload resolves stored references through session authorization, including when the generating tool is unavailable. The [media output decision](../../../.agents/notes/implemented/feature/2026-10-03-standalone-media-generation-output.md) owns placement and persistence.

Business UI packages register only their wire Tool names and atomic views. They do not pair Session events, rebuild the transcript, or own root/subcall topology. The Runtime remains authoritative for call/result pairing, lifecycle, and recursive `subCalls` projection; the conversation view remains authoritative for ChatFlow placement.

Pending previews use the call's optional positive `aspectRatio` (requested width divided by height); provider-selected dimensions remain unspecified until output arrives. Generated images and pending previews fill the card width while preserving their ratios without cropping. Video controls use intrinsic video dimensions with a 480px height bound.

The model caption resolves the actual result's model ID through its provider catalog and displays only its name; an unavailable catalog or removed model retains the ID. Provider identity remains in the recorded result and generation details. The authored prompt is selectable and has a copy action. Generation details open the Trajectory inspector, whose Payload and Result copy controls preserve the complete recorded text.

## Rendering contract

`ToolCallTree` receives one root `ToolCallBlock` that already contains recursive `subCalls`, selection state, the session `cwd`, and Host callbacks for opening files and inspecting calls. It recursively walks the standard call blocks and sends the root and children at every depth through the same atomic dispatch path, without subscribing to a separate parent-to-children map.

Each root and child wrapper preserves the `data-chat-anchor-key="call:<id>"` and `data-chat-call-id` DOM contract used for paging and selection.

Successful generic result views may contain image blocks for chat presentation. The call tree passes their references to the conversation owner's `renderMessageImages` callback, which selects the shared attachment gallery through its slot. Tool presentation does not import gallery components or resolve image bytes itself.

The package also fills `conversation.details.tool` with `ToolDetails`. The row and details renderers share the same pure card models for `terminal`, `read`, `diff`, `search`, and `web` render intents. Unknown intent tags and malformed wire card data fall back to flattened Tool result text.

Generic rows classify known Tool names into search, read, shell, write, edit, code, or generic variants. Running, successful, failed, and interrupted lifecycle states come only from the frozen call/result slice. File paths resolve against the session `cwd` only when the user invokes the Host open-file callback; presentation code does not read Session services.

## Atomic Tool views

An owning business package registers its wire Tool name into `tool.call.toolview`:

```ts ignore-check
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: '<wire tool name>',
  }, BusinessToolRow))
```

The owner payload is `ToolCallOwnerProps`: `callId`, `toolName`, the frozen `block`, optional `cwd` and `home`, and plain `openFile`/`inspect` callbacks. Path summaries relativize to the session cwd first, then replace a leftover POSIX host home with `~`; `filePath` and Host open keep the authored filesystem path. The registration receives the normal session slot runtime share. It does not receive React nodes, Runtime services, or root/subcall knowledge.

This package currently owns the generic fallback and the built-in shell/pwsh, read, write/edit, grep/glob, web, todo, question, and Code Dispatch presentations. `ui-skill` demonstrates a business-owned registration for `skill`.

Card-specific limits and fallback rules remain in the owning [terminal](../../../.agents/notes/implemented/feature/2026-07-28-web-terminal-card.md), [diff](../../../.agents/notes/implemented/feature/2026-07-30-web-diff-card.md), [read](../../../.agents/notes/implemented/feature/2026-07-30-web-read-card-frontend.md), [search](../../../.agents/notes/implemented/feature/2026-07-30-web-search-card.md), and [web](../../../.agents/notes/implemented/feature/2026-07-30-web-result-card-frontend.md) notes.

## Model Experience

None, as this package renders already logged Tool calls and results without altering model requests, Tool execution, or session events.

#### KV Cache effect

None. The package is client-only presentation.

## Known Limitations and Deferred Work

- The Host excludes `run_code` from Code Mode program bindings, so production events produce one dispatch level; the recursive Runtime/UI contract supports nesting.
- First-party Tool views are colocated here and can move to their owning business packages independently through the keyed slot.
- Tool copy reuses the `ui-conversation` locale namespace.
- Video loading buffers the session attachment response; large provider videos need a streamed read route. Video provider submission/polling is outside this presentation plugin.
