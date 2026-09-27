# @hydra/harness-obsidian-knowledge

Provides token-bounded graph memory over an Obsidian vault. Production reads and writes use Obsidian Local REST API's built-in MCP server; raw MCP tools are never exposed to the model. Graph notes live under `Hydra Website Knowledge/`.

## Configuration

Mount the plugin in a Hydra profile or patch:

```yaml
- id: obsidian-knowledge
  name: '@hydra1902/harness-obsidian-knowledge'
```

Recall, exact reads, and approval-gated saves work with no user-facing settings. The settings document intentionally contains no vault path, MCP URL, or token.

Existing vault notes, including page/control/action notes, remain untouched. Obsidian settings do not restrict browser navigation or trigger evidence capture.

The Web app exposes the write-only `OBSIDIAN_API_KEY` credential under **Settings → Plugins → MCP**. The credential stays outside the settings document, and the MCP endpoint remains deployment configuration.

Enable the Local REST API community plugin and its built-in MCP server in the intended vault. Create the unique marker `Hydra Website Knowledge/Hydra MCP Vault Identity.md`; Hydra harness reads it before each operation so a different open vault fails closed. Hydra harness connects on demand to `http://127.0.0.1:27123/mcp/`, uses a five-second timeout, and resolves the bearer token from Hydra credential reference `OBSIDIAN_API_KEY`.

This plugin is independent of Browser tooling. It never observes, gates, or reads `browser_*` tool calls or results.

## Behavior

`obsidian_knowledge_recall` searches once per intent and returns at most six ranked matches. It exact-reads only the strongest three matches internally, replaces their raw search fragments with focused excerpts of at most 320 characters, and follows explicit Obsidian wikilinks to expose at most 32 related exact paths. Linked note bodies are not included. This combines title, phrase, typed-note, and graph context without adding an embedding index or vector-store dependency.

`obsidian_knowledge_read` reads one to 32 selected extensionless paths as complete Markdown in one batch. The 64 KiB batch limit and path-containment checks fail the whole read for missing, invalid, mismatched, or oversized input rather than returning partial evidence.

`obsidian_knowledge_save_approved` is the only model-facing write path. The host asks the user to approve the exact call before saving under `Hydra Website Knowledge/Approved Knowledge/`.

## Model Experience

### Obsidian graph memory

#### What the model sees

One stable prompt section instructs the model to call `obsidian_knowledge_recall` once, select match or related paths, and exact-read them in one `obsidian_knowledge_read` batch. Recall output contains short ranked context and graph edges; exact reads contain only the complete notes selected by the model.

#### Token effect

Recall output is capped at six 320-character excerpts plus 32 path-only graph neighbors. Only three seed notes are read internally to discover context, and linked bodies enter the conversation only when selected for the bounded exact-read batch. This avoids returning a full feature collection merely to discover its testcase links.

#### KV Cache effect

Tool schemas and the prompt prefix stay stable. Data-dependent excerpts, paths, and complete notes are appended only when requested.

## Known Limitations and Deferred Work

- Retrieval uses Obsidian search plus explicit wikilinks, not embedding similarity. Add a semantic index only after measured misses justify its dependency, migration, and index lifecycle.
- Graph expansion follows one hop from the three strongest matches. Read a returned related note and recall a narrower intent when deeper traversal is needed.
- Obsidian and its Local REST API MCP server must be running, and `OBSIDIAN_API_KEY` must resolve, for knowledge access.
