# browser/ — embedded browser family

This family gives the harness a browser of its own: one Electron window per agent, opened on that agent's first browser action and closed with it. The model controls the page as a numbered text DOM (`[12]<button>Save</button>`) and acts by index through the upstream [PageAgent](https://github.com/alibaba/page-agent) engine (Core, LLM loop, and PageController) bundled into the view's preload; that control loop uses neither page screenshots nor a vision model. Browser annotations are a separate user-composer path and may add a bounded screenshot of a selected element or viewport region according to the desktop setting. Hydra harness, not the target webpage, owns the visible control surface.

| Package | Role | ctx key |
|---|---|---|
| [`browser-electron/`](browser-electron/README.md) | Owns the Electron process, the window, and the NDJSON control channel | `ctx.browsers` |
| [`tool-browser/`](tool-browser/README.md) | Exposes browser navigation/actions plus explicit upstream PageAgent controls | registers on `ctx.tools` |
| [`obsidian-knowledge/`](obsidian-knowledge/README.md) | Recalls graph-linked Obsidian memory and optionally records approved Browser facts | registers on `ctx.tools` |

The split is the same consumer/seam one as `web/`: everything the model sees — schemas, the DOM-format prompt section, the output cap, the card titles — is decided in `tool-browser`, and nothing there knows the browser is Electron. Unlike `web/` there is no provider registry, because a single-purpose plugin stays one package until a second backend actually exists.

`electron` is an optional dependency. Without it the seam still loads and every call fails with `BROWSER_UNAVAILABLE`, so a deployment that cannot carry a ~200 MB binary — the single-exe build, for one — keeps the rest of the harness intact.

**The browser profile carries real SSO cookies.** It persists across sessions by design, which also means a prompt-injected page can steer the agent into acting as the signed-in user. The generic browser follows Chromium navigation; an optional plugin such as Obsidian knowledge can apply a hostname and non-bare-entrypoint guard before a URL-bearing browser action. The residual exposure is in [browser-electron's security section](browser-electron/README.md#security).
