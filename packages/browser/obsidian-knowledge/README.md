# @bosch/bh-obsidian-knowledge

Provides token-bounded graph memory over an Obsidian vault. Production reads and writes use Obsidian Local REST API's built-in MCP server; raw MCP tools are never exposed to the model. The package keeps the existing `BH Website Knowledge/` vault root so current notes remain valid after the package rename.

## Configuration

Mount the plugin in a BH profile or patch:

```yaml
- id: obsidian-knowledge
  name: '@bosch/bh-obsidian-knowledge'
```

Generic recall, exact reads, and approval-gated saves work without website configuration. To add Browser evidence capture, configure one canonical hostname in the existing BH settings document:

```yaml
obsidian-knowledge:
  targetDomain: workon.example.internal
```

`targetDomain` accepts one hostname without protocol, port, path, wildcard, or implicit subdomain matching. The settings document intentionally contains no vault path, MCP URL, or token.

Enable the Local REST API community plugin and its built-in MCP server in the intended vault. Create the unique marker `BH Website Knowledge/BH MCP Vault Identity.md`; BH reads it before each operation so a different open vault fails closed. BH connects on demand to `http://127.0.0.1:27123/mcp/`, uses a five-second timeout, and resolves the bearer token from BH credential reference `OBSIDIAN_API_KEY`.

## Behavior

`obsidian_knowledge_recall` searches once per intent and returns at most six ranked matches. It exact-reads only the strongest three matches internally, replaces their raw search fragments with focused excerpts of at most 320 characters, and follows explicit Obsidian wikilinks to expose at most 32 related exact paths. Linked note bodies are not included. This combines title, phrase, typed-note, and graph context without adding an embedding index or vector-store dependency.

`obsidian_knowledge_read` reads one to 32 selected extensionless paths as complete Markdown in one batch. The 64 KiB batch limit and path-containment checks fail the whole read for missing, invalid, mismatched, or oversized input rather than returning partial evidence. With `targetDomain` configured, complete notes can also emit bounded same-domain application-root candidates from literal `WorkOn...` identifiers.

`obsidian_knowledge_save_approved` is the only model-facing write path. The host asks the user to approve the exact call before saving under `BH Website Knowledge/Approved Knowledge/`. When Browser capture is configured, cited observations from the current or immediately previous turn are committed with the proposal. Page notes link controls and actions so Obsidian's native graph retains `page -> control` and `page -> action -> resulting page` relationships. Typed input and selected-option values are not persisted.

`obsidian_knowledge_read_browser` returns current evidence only after a successful Browser result on the exact configured hostname. Browser navigation remains live evidence, while historical vault notes remain context. Authentication, protocol, marker, malformed-result, or required-note failures do not fall back to filesystem discovery; the agent must report `Unresolved`.

## Model Experience

### Obsidian graph memory

#### What the model sees

One stable prompt section instructs the model to recall once, select match or related paths, and exact-read them in one batch. Recall output contains short ranked context and graph edges; exact reads contain only the complete notes selected by the model. Configuring `targetDomain` adds Browser-navigation and evidence rules to the same section.

#### Token effect

Recall output is capped at six 320-character excerpts plus 32 path-only graph neighbors. Only three seed notes are read internally to discover context, and linked bodies enter the conversation only when selected for the bounded exact-read batch. This avoids returning a full feature collection merely to discover its testcase links.

#### KV Cache effect

Tool schemas and the prompt prefix stay stable. Data-dependent excerpts, paths, complete notes, and Browser evidence are appended only when requested.

## Known Limitations and Deferred Work

- Retrieval uses Obsidian search plus explicit wikilinks, not embedding similarity. Add a semantic index only after measured misses justify its dependency, migration, and index lifecycle.
- Graph expansion follows one hop from the three strongest matches. Read a returned related note and recall a narrower intent when deeper traversal is needed.
- Browser capture sees BH's viewport-scoped text DOM, not selectors, screenshots, or unvisited pages.
- Obsidian and its Local REST API MCP server must be running, and `OBSIDIAN_API_KEY` must resolve, for knowledge access.
