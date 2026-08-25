# @bosch/bh-browser-electron

Owner-scoped embedded browser. `BrowserSessionService` registers as `ctx.browsers`, starts one Electron window per `Agent` on that agent's first action, and closes it with the agent. Its native chrome lets the user add, select, and close tabs; every controlled page runs the real upstream [PageAgent](https://github.com/alibaba/page-agent) engine in its view preload: Core ReAct loop, LLM client, and PageController. BH keeps the upstream Panel out of the webpage and shows PageAgent's passive simulator mask and virtual cursor only while it performs an indexed DOM action or runs PageAgent. The normal browser tools retain the numbered text DOM (`[12]<button>Save</button>`) and indexed actions; explicit `page_agent_*` actions start or control the upstream loop.

## Contract

- One `Agent` owns one window. `perform(owner, action)` starts it lazily; there is no explicit open call, because "open a browser" is not a decision the model should make separately from using one. An optional `homeUrl` loads before the child reports ready, so a fresh window opens on the configured site rather than `about:blank`.
- Every `perform` ends with a state read. Navigation, tab changes, and direct state reads wait boundedly for Chromium to be idle and the SPA to expose usable content; `settled: false` makes an exhausted wait explicit rather than treating an empty shell as final UI evidence. `PageController` assigns element indices while building the tree, so the trailing snapshot both answers the caller and leaves the next action addressable.
- Page-local actions may name a stable `tabId`. Calls for one tab are serialized because each trailing state read replaces that tab's valid element indices; calls for different explicit tabs may overlap. Untargeted and tab-lifecycle actions are window-wide barriers and capture the selected tab when Electron receives them.
- Actions use page-agent's own wire names (`click_element`, `input_text`, `select_option`, `scroll`, `scroll_horizontally`, `execute_javascript`, `get_browser_state`) plus harness navigation, readiness, tab, and upload actions. `navigate`/`back`/`press`/`wait`/tab actions/`upload_file` are answered by the Electron main process; DOM actions reach the preload.
- PageAgent's own OpenAI-shaped LLM calls cross one private Electron IPC channel to the owning BH agent, which runs its currently selected provider and model. The page never sees an API key, a model endpoint, or BH IPC.
- The native chrome mirrors every tab title and the selected tab's URL. Its omnibox opens an `http:` or `https:` address directly; any other text searches Google. Back, Forward, and Reload act on the selected tab; selecting another tab does not cancel work explicitly targeted at the previous one.
- Each controlled tab follows normal Chromium navigation: redirects and links are not origin-filtered by the harness. `window.open()` pages are adopted into a new controlled tab, so their text DOM can be inspected and selected by the model.
- A navigation, renderer crash, tab close, or user closing the window invalidates the affected indices. In-flight DOM calls reject rather than resolving against a different or missing document, and the next `perform` after a closed window starts a fresh one.
- Failures are machine-routable through `BrowserError.code`: `BROWSER_UNAVAILABLE` (no `electron` installed), `BROWSER_LAUNCH_FAILED` (with the child's stderr tail), `BROWSER_GONE`, `BROWSER_TIMEOUT`, `BROWSER_DISPOSING`.
- An action that the page rejects is not an error. `{ success: false, message }` is a result the model can read and act on; only the transport and the process lifecycle throw.

The seam contains no tool schema, prompt, approval, or rendering policy. `@bosch/bh-tool-browser` owns everything the model sees.

## Layout

```
electron-app/main.cjs         window + chrome/page WebContentsViews + NDJSON loop over fd 0
electron-app/chrome.html      static tab strip and omnibox UI
electron-app/chrome-preload.cjs sandboxed chrome IPC wiring
electron-app/preload.entry.js source of the preload bundle
electron-app/preload.cjs      committed build output — what Electron actually loads
third-party/page-agent/       upstream-pinned PageAgent source submodule
vite.preload.config.js        bundles the upstream runtime and preload into one CJS file
src/                          the Node half: service, child process, types
```

`electron-app/*` runs in Electron, not in the harness's Node process, and is published as-is rather than built by tsdown.

The parent talks to the child in NDJSON over stdin/stdout — one JSON object per line, `{id, method, args}` out and `{id, ok, result|error}` back. No port to ask for, no `EADDRINUSE`, and the channel dies with the process. The cost is that `main.cjs` may never `console.log`: stdout *is* the channel, and every diagnostic goes to stderr.

## Rebuilding the preload

`electron-app/preload.cjs` is committed. Regenerate it only when the upstream submodule or `preload.entry.js` changes:

```
pnpm --filter @bosch/bh-browser-electron run build:preload
```

The exact upstream commit is the [`third-party/page-agent`](third-party/page-agent) gitlink; the licence is in [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).

## Installing the Electron binary behind a proxy

`electron` is an `optionalDependency`: without it the plugin still loads and every call fails with `BROWSER_UNAVAILABLE`, and the rest of the harness is unaffected. Its postinstall downloads a ~200 MB binary through `@electron/get`, which uses undici's `fetch` and therefore **ignores npm's `proxy` / `https-proxy` settings**. Behind a corporate proxy the download needs the environment variables:

```
HTTPS_PROXY=http://localhost:3128 HTTP_PROXY=http://localhost:3128 \
  node node_modules/.pnpm/electron@43.4.1/node_modules/electron/install.js
```

The postinstall also needs `electron: true` under `allowBuilds` in `pnpm-workspace.yaml`; `strictDepBuilds` blocks it otherwise.

## Security

The controlled view runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload never calls `contextBridge`, so `ipcRenderer` never leaves module scope and a hostile document has no handle on the control channel. The window is headed by default: the user watches what the agent does.

**Navigation intentionally behaves like Chromium.** The harness does not filter page redirects, links, or `window.open`, so enterprise SSO may complete its normal cross-origin flow. A `window.open()` page is adopted into another controlled tab; the user and model can select it from the same tab inventory.

**The profile carries real SSO cookies.** `userDataDir` defaults to `<harness-home>/browser-profile` and persists, which is the point — logging in once should survive the session. Set `persistSessionCookies: true` when the profile must also retain otherwise session-only SSO cookies: BH promotes them into Chromium's encrypted cookie store for 30 days and flushes the store before a harness-owned exit. It also means a prompt-injected page can steer the agent into acting as the signed-in user against any site that profile is authenticated to. This is the same class of risk as the deferred SSRF protection on `web_fetch` ([web capability seam](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md#deferred-work)): do not enable the embedded browser where an untrusted page can be reached with a profile authenticated to sensitive internal systems.

Set `homeUrl` only in the user's profile patch when a deployment has one trusted default site; it does not replace Obsidian knowledge as the source of application-specific routes.

**File selection is fail-closed.** `upload_file` accepts only an absolute, readable regular-file path that a direct user wrote as a standalone or quoted literal in the current open turn. It targets only an indexed HTML `<input type="file">` on the requested HTTP(S) tab, verifies that the target origin did not change, and selects the file through Chromium's DOM protocol without page JavaScript. A workflow consumer remains responsible for restricting which configured domain may invoke it.

## Model Experience

### Indirect consumer

#### What the model sees

Nothing directly. This package registers no prompt and no tool; `@bosch/bh-tool-browser` owns the visible schemas, the DOM-format prompt section, and the result text.

#### Token effect

None directly. A page's text DOM stays process-local until a consumer returns a bounded result.

#### KV Cache effect

No direct invalidation; the named consumer owns request-prefix changes.

## Known Limitations and Deferred Work

- No screenshot. `capturePage()` into `ctx.attachments.saveImage()` is a small addition, deferred until a page proves the text DOM insufficient.
- `execute_javascript` is experimental and host-gated by `experimentalScriptExecution`; it runs in PageAgent's isolated document world, cannot access page-world JavaScript globals, and can mutate the current page.
- No screenshot or iframe traversal. File upload supports an observed HTML file input, but not a proxy button or hidden chooser control.
- Sessions are process-local: a harness restart loses the window, though the profile keeps the login.
- One agent owns one Chromium profile and window. Parallelism is across that window's isolated tabs; use separate agents when work requires independent browser profiles or windows.
