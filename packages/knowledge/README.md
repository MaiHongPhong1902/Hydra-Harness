# knowledge/ — persistent knowledge

Plugins in this group own persistent knowledge records through their declared stores. Obsidian knowledge is independent of Browser tooling; page memory intentionally consumes the Browser service to verify page-local guidance.

| Package | Role | ctx key |
|---|---|---|
| [`obsidian-knowledge/`](obsidian-knowledge/README.md) | Recalls graph-linked vault notes, reads exact paths, and saves user-approved knowledge through Obsidian MCP | registers on `ctx.tools` |
| [`page-memory/`](page-memory/README.md) | Recalls and replaces verified task guidance for the current Browser page in private SQLite | registers on `ctx.tools`, `ctx.browsers`, and `ctx.systemPrompt` |
