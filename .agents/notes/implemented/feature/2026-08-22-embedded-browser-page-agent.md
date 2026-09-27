# Agent Note: Embedded browser driven by the harness's own loop

Status: implemented

## Problem

The harness could read the web and not use it. `web_fetch` retrieves a document; nothing could fill a field, press a button, or follow a flow that only exists behind a login. Signed-in internal applications are forms the user already occupies, and no amount of fetching reaches them.

Three things had to be true of whatever closed that gap.

The **harness's own loop** had to be the one driving. The obvious shortcut is to hand a page to something that already knows how to browse and let it work — a second agent with a second model and a second definition of "done". That buys a demo and loses the product: the user's turn no longer explains itself, the tool results are somebody else's summary, and two loops now negotiate over one task.

The browser had to be **the harness's own**, and it had to open itself. A capability that first asks the user to install an extension, start Chrome with a debug port, or keep a window parked is a capability most sessions will not have. It should appear on the first call and leave with the agent, the way a terminal does.

And the modality had to be **text**. A screenshot loop needs a vision model, spends thousands of tokens a step, and still cannot tell the model which of two identical buttons it is looking at.

## Decision

Two packages under a new `browser/` family, and a vendored perception core.

`@hydra/harness-browser-electron` owns `ctx.browsers`: one Electron child process per `Agent`, spawned on that agent's first action and closed with it, holding one window and one `WebContentsView`. The parent speaks NDJSON over the child's stdin/stdout — `{id, method, args}` out, `{id, ok, result|error}` back.

`@hydra/harness-tool-browser` owns everything the model sees: the `browser_*` schemas, the DOM-format prompt section, the character cap, the card titles, the origin approval. Nothing in it knows the browser is Electron.

The page is perceived and driven by the locally owned BrowserAgent `PageController`, copied from [page-agent](https://github.com/alibaba/page-agent) at `packages/browser/browser-electron/third-party/browseragent/packages/page-controller/` and bundled into the view's preload. It turns the live DOM into a numbered element list — `[12]<button>Save</button>` — and acts by index. Its own header says it is "designed to be independent of LLM", and that is exactly the half taken. PageAgent's ReAct core is an explicit, demoted Hydra tool, not the default loop; see [Hydra-owned browser control](../architecture/2026-09-07-hydra-owned-browser-control.md).

### The extension, ported

Page-agent already solves this problem for Chrome, and the Electron shape is that solution with the transports swapped. Nothing in the middle had to be invented:

| page-agent extension | here |
|---|---|
| content script (`<all_urls>`) | the `WebContentsView`'s preload |
| background service worker | the Electron main process |
| `chrome.runtime.sendMessage` | `ipcMain` ↔ `ipcRenderer` |
| tab hub over WebSocket | NDJSON over the child's stdio |
| `RemotePageController` | `ctx.browsers` in the harness |

The action names cross unchanged — `get_browser_state`, `click_element`, `input_text`, `select_option`, `scroll` — so no layer translates between the harness and the vendored controller. `navigate`, `back`, and `press` are answered by the main process instead, because `loadURL`, `navigationHistory.goBack()`, and `sendInputEvent` are browser operations no page script can perform. `press` is the one page-agent has no equivalent for at all, and real forms need it.

### Where the browser may go

Both layers start closed, and both fail closed.

`browser_navigate` resolves the URL's origin, refuses anything that has none (a relative path, `file:`, `data:`), and for an origin outside the `allowedOrigins` config asks `ctx.get('approval')` — before a window exists. A rejection, a cancellation, no answerer, or no approval service at all all refuse. The grant is remembered per agent and per origin.

The seam then carries the decision down through `allowOrigins(owner, origins)`, and the Electron main process refuses every `will-navigate` whose origin is not in its set. That second layer is not redundant: a link, a script, or a `<meta refresh>` is a navigation no tool call ever passes through, so the tool layer never sees it. Grants outlive the window — a replacement main process is told all of them before it is allowed to act, because a fresh process starts with an empty set.

Approval is per origin rather than per call because granting an origin *also* unblocks the page's own movement within it. Asking twice for a site the window is already free to walk around in would be theatre.

### Security posture

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload never calls `contextBridge`, so `ipcRenderer` never leaves module scope and a hostile document has no handle on the control channel. `setWindowOpenHandler` denies every `window.open`. The window is headed by default: the user watches what the agent does.

There is no `browser_run_js`, permanently. `eval()` in the preload runs in the isolated world rather than the page's, so it would silently answer the wrong question — and dropping it drops the eval surface with it. Page-agent reached the same conclusion for its own reason (`AbortSignal` does not cross the context boundary).

The profile persists at `<harness-home>/browser-profile`, which is the point — logging in once should survive the session — and is also the residual exposure: a prompt-injected page can steer the agent into acting as the signed-in user within an origin it was granted. The allowlist narrows this; it does not close it. Same class as the deferred SSRF protection on `web_fetch` ([web capability seam](../architecture/2026-06-24-web-capability-seam.md#deferred-work)).

## Alternatives considered

**Page-agent as a sub-agent.** Compose page-agent's `PageAgentCore` and let it own the browsing task end to end. Rejected outright, and it is the decision the rest follows from: the harness's loop stops being the thing that reasons about the page, the model's tool results become another agent's prose, and two LLM loops negotiate over one user turn. Vendoring only `PageController` keeps the perception and the actions and throws away the second brain.

**Playwright or raw CDP.** Both drive a browser well and neither gives a text DOM. The element indexing, the `*[` new-element marking, the viewport-only listing, and the React-safe input patches are `PageController`'s actual value, and they would have had to be rewritten on top of either. Playwright would also have added a second ~200 MB browser download beside Electron's.

**The Chrome extension, unchanged.** Page-agent's own deployment: install the extension, run the hub, connect over WebSocket. It works, and it requires the user to install an extension, keep a browser open, and trust the harness in the same profile as the rest of their browsing. It also leaves the harness unable to open a window it did not already have.

**Screenshots and a vision model.** Rejected on cost and precision: thousands of tokens a step, a vision-capable model as a hard requirement, and no way to name one of two identical buttons. `capturePage()` remains a small addition if a page ever proves the text insufficient.

**A WebSocket control channel.** The extension's transport, and the natural one to copy. NDJSON over stdio needs no port, cannot collide (`EADDRINUSE`), never crosses the `/api` trust fence, and dies with the process. The cost is that the main process may never write to stdout — that stream *is* the channel — so every diagnostic goes to stderr.

**Three packages instead of two.** The Service Definition / Provider / Consumer split that `web/` uses. There is one implementation and no second backend in sight; splitting the definition out now would be an interface with one implementation. `docs/cookbook/adding-a-package.md` says it directly: a single-purpose plugin stays one package.

**`contextIsolation: false` to reach the page's world.** Would have made an `execute_javascript` action possible and would have handed every page a path to `require`. Checked instead that `PageController` runs correctly in the isolated world — its React patch is plain `setAttribute`, and the MV3 extension already runs the same code there — so nothing was given up.

**Depending on an external PageController package.** The published build leaves `ai-motion` and its siblings as bare specifiers, and a preload with `sandbox: true` has no module resolver. A self-contained bundle needs the source, so the private `@hydra/harness-browseragent-page-controller` package is tracked here with its provenance and licenses recorded beside it.

## Consequences

**Electron is optional, and that is load-bearing.** It is a `peerDependenciesMeta.optional` peer with a ~200 MB postinstall download and an `allowBuilds` entry in `pnpm-workspace.yaml`. Without it the plugin still loads, the tools still register, and every call fails with `BROWSER_UNAVAILABLE` — so the single-exe build, which cannot carry it, keeps the rest of the harness intact. Behind a corporate proxy the download needs `HTTPS_PROXY` set for `@electron/get`, which ignores npm's own proxy settings.

**The BrowserAgent copy is an owned source surface.** `third-party/browseragent/` keeps upstream attribution and APIs while Hydra changes are committed directly beside the regenerated `electron-app/preload.cjs`.

**One window, several tabs, with forward.** Each tab is a `WebContentsView`. `browser_forward` is a first-class model tool beside `browser_back`. Horizontal scroll and file upload are wired; iframe traversal is not.

**Approval never expires and redirects are not re-checked.** A granted origin is granted for the agent's life, and a `302` out of one raises `will-redirect`, which the guard does not listen to. The model is bounded in what it *aims* the browser at, not in every document that ends up in it.

**Origin approval and navigation blocking are superseded.** The user-approved Chromium-compatible navigation policy is recorded in [Chromium-compatible embedded browser navigation](../architecture/2026-08-22-unrestricted-embedded-browser-navigation.md); the original ownership, text-DOM, and persistent-profile decisions remain in force.

**The text DOM is cheap per element and expensive per page unless compacted.** A page whose DOM churns still produces a fresh, differently numbered list on every call. Full dumps are reserved for `browser_state` and `browser_navigate`; ordinary actions return a ranked ~4k snapshot. The cost decision is recorded in [Hydra-owned browser control](../architecture/2026-09-07-hydra-owned-browser-control.md).

## Testing

Three tiers, because the process boundary is where this can go wrong.

- **Unit** (`packages/browser/*/tests`) — the service against a scripted child over real streams: id matching, timeouts, reject-on-child-death, the per-owner queue, origin-grant replay into a replacement process. The tool package covers approval end to end: pre-allowed, asked once per origin, rejected, cancelled, no answerer, no service.
- **Real Electron** (`browser-electron/tests/electron.spec.ts`) — a real window against a local fixture form: navigate, read, type, select, click, back, press, and a page-initiated link to an ungranted origin that must not move the window. Self-skips without the binary or a display, the way the with-key e2e suites skip without their keys.
- **Snapshot** (`examples/acp-agent`, scenario `browser-tool-turn`) — the `browser_*` schemas, the prompt section, and the rendered page text pinned through a real ACP turn. The overlay scripts the Electron child through the service's own `spawnChild` seam and leaves every layer below the process real; a real window would need the binary, a display, and would report host-dependent viewport metrics.

Writing the Electron guard surfaced one fact worth keeping: **`did-start-navigation` fires before `will-navigate`** in Electron 43. Two attempts that set a flag in the latter and read it in the former both failed. The shipped guard is order-independent — both handlers consult the same allowlist, and a `harnessNavigating` flag marks the main process's own navigation, which raises neither event.

## Related

The subsystem vocabulary is [docs/subsystems/browser.md](../../../../docs/subsystems/browser.md); the seam and consumer READMEs under `packages/browser/` own the operational detail. The lazy-spawn, owner-scoped, dispose-with-the-agent shape follows `TerminalSessionService`, and the per-owner serialization follows `tool-bash-persistent`.

## 2026-08-24 update: PageAgent capability parity for testcase evidence

The 2026-08-22 statements about eight tools, permanent JavaScript omission, deferred tabs/horizontal scroll, and native-only popups are superseded by this update.

The harness still keeps PageAgentCore off the default path: Hydra owns the model loop, completion decision, tool policy, and evidence lifecycle. `browser_page_agent_run` is an explicit, demoted tool; see [Hydra-owned browser control](../architecture/2026-09-07-hydra-owned-browser-control.md). Hydra-owned PageController tools cover state, navigation, explicit bounded wait, indexed or named actions, find, fill, vertical/horizontal scroll, forward, and model-addressable open/switch/close tab. Each Browser state carries a controlled-tab inventory, capture time, and `settled` status.

Electron owns readiness because it owns document/tab transitions. After navigation, a tab change, a page-initiated navigation, or an explicit state read, it follows redirects and waits boundedly for Chromium to be idle and PageController to expose usable SPA content. A timeout returns `settled: false`; the Obsidian recorder discards that transient snapshot instead of allowing it to become durable UI evidence.

`window.open()` is adopted into another controlled tab. `execute_javascript` is available only when the host's `experimentalScriptExecution` flag is true, and that flag is enforced both by the service and Electron main process. It remains isolated-world JavaScript: it can inspect or mutate the document, but cannot access page-world globals or serve as a policy bypass.

The direct navigation/domain policy remains outside this generic seam. The Obsidian knowledge plugin applies its same-domain and non-bare-entrypoint guard to both `browser_navigate` and URL-bearing `browser_open_tab` calls.

Focused coverage now includes a real Electron delayed SSO redirect plus empty-to-hydrated SPA, page-initiated navigation, tabs, horizontal scroll, experimental JavaScript, host-side JavaScript denial, and deterministic model-facing snapshot replay.
