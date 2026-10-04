# Media generation

Image and video tools store durable artifacts for chat display, download, replay, and session export.

| Package | Responsibility | Services consumed |
|---|---|---|
| [tool-media](tool-media/README.md) | Image and video generation under one plugin switch | `ctx.tools`, `ctx.credentials`, `ctx.attachments`, optional `ctx.llm` |
