# @bosch/bh-obsidian-website-knowledge

Reads the configured Obsidian vault through Obsidian Local REST API's built-in MCP server and records facts observed through BH's embedded `browser_*` tools as Markdown and wikilinks. The plugin is inactive until `targetDomain` is configured. Obsidian MCP is the only production knowledge backend: an unavailable credential, MCP endpoint, marker, or required note fails closed. A URL must match the configured hostname exactly; a subdomain, lookalike domain, non-HTTP(S) URL, or browser failure writes nothing.

## Configuration

Mount the plugin in a BH profile or patch:

```yaml
- id: obsidian-website-knowledge
  name: '@bosch/bh-obsidian-website-knowledge'
```

Then configure the existing BH settings document:

```yaml
obsidian-website-knowledge:
  targetDomain: workon.example.internal
```

`targetDomain` is a canonical hostname only: no protocol, port, path, wildcard, or subdomain matching. The settings document intentionally contains no vault path, MCP URL, or token. The plugin writes only below `BH Website Knowledge/<targetDomain>/` and never stores `browser_type` text or selected-option text.

Enable the Local REST API community plugin, including its built-in MCP server, in the intended vault. Create one unique technical marker at `BH Website Knowledge/BH MCP Vault Identity.md`; BH reads that marker through MCP before every operation, so a different or unavailable open vault fails closed. BH connects on demand to `http://127.0.0.1:27123/mcp/` with a 5-second timeout and resolves the bearer token from credential reference `OBSIDIAN_API_KEY`. Store that secret through BH's credentials service; do not add MCP fields or the secret to settings YAML.

## Behavior

Every successful target-domain `browser_*` result is staged in the agent session. Each tab keeps its own previous page, so interleaved results never create a transition between unrelated tabs. `website_knowledge_read` exposes the latest current evidence without writing it. When the user approves a proposal and the agent calls `website_knowledge_save_approved`, only staged results whose exact URLs are cited by that proposal are published, using the current turn or the immediately previous turn when approval follows the proposal. Action notes retain the Browser-reported success flag and message. Existing page notes link their outgoing action notes, so Obsidian's native graph renders:

```text
page → control
page → action → resulting page
```

The model-facing `website_knowledge_read` tool returns evidence for the current target-domain browser page. It waits for the preceding browser capture and refuses when no target-domain page has been observed, so the live Browser result remains the source of truth for each click. Call `website_knowledge_search` once per term as `{"query":"term"}`; it uses Obsidian MCP search, reranks the complete valid hit set by exact phrase, term coverage, individual test-case evidence, and stable path, then returns at most eight excerpts and their exact paths. Excerpts locate candidates only. Pass those paths to `website_knowledge_read_notes` to read up to 32 complete persisted notes through MCP before relying on source fields. The exact read also emits bounded same-domain application-root candidates copied from literal `WorkOn...` identifiers in those complete notes. The batch is capped at 64 KiB and fails as a whole for an invalid, missing, mismatched, or oversized note instead of truncating evidence. A missing credential, unavailable MCP transport, rejected authentication, protocol error, marker failure, valid empty result, or malformed response does not fall back to filesystem discovery; the agent must report `Unresolved`. Both tools report `obsidian-mcp` as their backend.

Raw Obsidian MCP tools are not exposed to the model. `website_knowledge_save_approved` remains the sole write path: the host requests explicit approval for the exact call before committing staged Browser evidence or the proposal. The model-supplied `approved-by-user` literal is retained as an intent marker, not treated as authorization by itself.

## Model Experience

### Browser knowledge read

#### What the model sees

While the plugin is configured, one fixed prompt section separates persisted-note lookup from current Browser-page evidence. `website_knowledge_read_notes` returns complete source notes selected by exact search-result path plus structured application-root navigation candidates; `website_knowledge_read` returns the generated Markdown page note, including observed controls and transitions.

#### Token effect

The prompt structure and four tool schemas are fixed, while the prompt includes the canonical configured `targetDomain`. It directs UAT workflows from one focused vault search to one exact full-note read, forbids filesystem discovery fallbacks, and uses Browser evidence only when the question requires current UI or execution. A user request to verify, test, or execute a case requires a Browser call before any live result. Live navigation resolves without asking for a URL: it prefers an exact same-domain URL from the current conversation, then an approved role entrypoint note, then a structured application-root candidate emitted from complete matched knowledge. After an exact note read emits candidates, the host denies a bare configured-domain `browser_navigate` call and returns those candidates as corrective evidence. A candidate must be confirmed by live Browser output, while deep paths and database, API, SQL, attachment, or evidence links are never guessed as UI routes. Navigation stays ephemeral; persisting a discovered entrypoint still requires approval. Search results are bounded excerpts; exact reads return complete notes or fail closed. Browser observations remain visible through their normal `browser_*` results.

##### Approved entrypoint note

```markdown
# WorkOnBackoffice browser entrypoint

- URL: https://workon.example.internal/actual-backoffice-path
- Provenance: user-approved
```

#### KV Cache effect

The prompt and schema are prefix-stable while the plugin remains configured. Each knowledge read appends data-dependent page content after the reusable prefix.

## Known Limitations and Deferred Work

- **Visible Browser DOM only** — BH's current Browser result exposes viewport-scoped numbered elements, not stable CSS selectors, href targets, screenshots, or unvisited pages. Add a browser seam observation with those facts only when the Browser provider can prove them.
- **MCP availability** — the plugin intentionally does not read the filesystem when MCP is unavailable. Restore the local Obsidian MCP server and its BH credential before requesting knowledge.
