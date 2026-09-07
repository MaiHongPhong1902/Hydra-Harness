# @hydra/harness-browser-electron

Owner-scoped embedded browser. `BrowserSessionService` registers as `ctx.browsers`, starts one Electron window per `Agent` on that agent's first action, and closes it with the agent. Its native chrome lets the user add, select, and close tabs, follows the desktop light/dark theme, and shows an agent status line, HTTPS lock, loading spinner, and tab favicons. Hydra owns the reasoning loop: each controlled page runs PageController for the numbered text DOM and indexed or named actions. `PageAgentCore` is constructed only when an explicit `page_agent_run` arrives. Hydra harness keeps the upstream Panel out of the webpage and hides PageController's index boxes and labels while retaining the simulator cursor and explicit annotation selection. The gradient appears only while browser commands are pending; the virtual cursor remains visible during manual browsing without blocking input. The native toolbar fits narrow panels, overflowing tabs scroll horizontally, and the page viewport follows the panel dimensions. Indexed clicks reject when their viewport point is covered by another page element, so actions cannot click through popups or headers.

## Contract

- One `Agent` owns one window. `perform(owner, action)` starts it lazily; there is no explicit open call, because "open a browser" is not a decision the model should make separately from using one. An optional `homeUrl` loads before the child reports ready, so a fresh window opens on the configured site rather than `about:blank`.
- Every `perform` ends with a state read. Navigation, tab changes, and direct state reads wait boundedly for Chromium to be idle and the SPA to expose usable content; `settled: false` makes an exhausted wait explicit rather than treating an empty shell as final UI evidence. `PageController` assigns element indices while building the tree, so the trailing snapshot both answers the caller and leaves the next action addressable.
- Page-local actions may name a stable `tabId`. Calls for one tab are serialized because each trailing state read replaces that tab's valid element indices; calls for different explicit tabs may overlap. Untargeted and tab-lifecycle actions are window-wide barriers and capture the selected tab when Electron receives them.
- Actions use page-agent's own wire names (`click_element`, `input_text`, `select_option`, `scroll`, `scroll_horizontally`, `execute_javascript`, `get_browser_state`) plus harness navigation, readiness, tab, find, fill, and upload actions. `navigate`/`back`/`forward`/`press`/`wait`/tab actions/`upload_file` are answered by the Electron main process; DOM actions reach the preload. Click, type, and select accept an index or a visible `name`. The first agent page action reveals the desktop Browser panel.
- `takeScreenshot(owner)` is a separate read contract: Electron captures only the selected controlled page's visible viewport through `WebContents.capturePage()`, never a background tab or Browser chrome. The transient canonical PNG is bounded to 3,500,000 bytes and 2,000 pixels per edge and is accepted only for an HTTP(S) page; the model-facing consumer must replace its base64 with a durable attachment before returning.
- PageAgent's own OpenAI-shaped LLM calls cross one private Electron IPC channel to the owning Hydra agent, which runs its currently selected provider and model. The page never sees an API key, a model endpoint, or Hydra IPC. `PageAgentCore` is created only for `page_agent_run`.
- The native chrome mirrors every tab title, favicon, and the selected tab's URL. Its omnibox opens an `http:` or `https:` address directly; any other text searches Google. An agent status line reports the current Hydra action. Back, Forward, and Reload do not reapply the default navigation policy to existing history entries, but an exact-origin site block still vetoes them; selecting another tab does not cancel work explicitly targeted at the previous one.
- Each controlled tab enforces the configured navigation policy before direct loads from `navigate`, `open_new_tab`, the omnibox, or the configured home page; popup requests are pre-checked, and Chromium's `will-navigate` and `will-redirect` boundaries cover page links and redirects. Same-origin navigation proceeds, non-HTTP(S) navigation is blocked, and an unrecognized cross-origin destination follows `allow`, `ask`, or `block`; `ask` offers native Allow once, Always allow, and Block choices, with remembered decisions stored for the exact canonical origin. Allowed `window.open()` pages are adopted into a new controlled tab, so their text DOM can be inspected and selected by the model.
- A navigation, renderer crash, tab close, or user closing the window invalidates the affected indices. In-flight DOM calls reject rather than resolving against a different or missing document, and the next `perform` after a closed window starts a fresh one.
- Failures are machine-routable through `BrowserError.code`: `BROWSER_UNAVAILABLE` (no `electron` installed), `BROWSER_LAUNCH_FAILED` (with the child's stderr tail), `BROWSER_GONE`, `BROWSER_TIMEOUT`, `BROWSER_DISPOSING`, `BROWSER_DISABLED` when the durable `browser-electron.controlEnabled` setting is off, and `BROWSER_POLICY_DENIED` when upload, sensitive-history, or Full CDP settings or approval deny an operation. Disabling control also stops detached PageAgent loops in every open tab and rejects their later model requests; one ordinary action already executing may finish.
- An action that the page rejects is not an error. `{ success: false, message }` is a result the model can read and act on; only the transport and the process lifecycle throw.

The seam contains no tool schema, prompt, or model-facing rendering policy. It does own the durable browser settings, native policy enforcement, and Host approval requests for uploads, sensitive-history searches, and Full CDP operations; `@hydra/harness-tool-browser` owns everything the model sees.

## Settings and browser management

The `browser-electron` namespace owns durable controls for agent access (`controlEnabled`, default `true`); user-opened URL routing (`webDestination` and `localDestination`, both `hydra`); annotation screenshots (`annotationScreenshots`, `include`); download location and prompting (`downloadDirectory`, `''`, and `askWhereToSave`, `false`); navigation, download, upload, and model-history policies (all `ask`); and the elevated Full CDP opt-in (`fullCdpAccess`, `false`). Every decision policy accepts only `allow`, `ask`, or `block`, and native-relevant changes are pushed to every active Electron controller.

The desktop routes absolute HTTP(S) links opened by its trusted renderer rather than letting them replace the app. Non-loopback links use `webDestination`; `localhost`, IPv6 loopback, and `127.0.0.0/8` links use `localDestination`. The system choice removes URL credentials and delegates to the OS browser, while the Hydra harness choice applies Browser navigation policy, opens a controlled tab, and reveals the Browser panel. Model-facing `browser_navigate` remains a controlled-browser action and does not use these user-link destination choices.

Quick annotate produces bounded URL, title, element-index, and HTML-preview text. Interactive Annotate produces the same element annotation for a click or short drag, or bounded URL, title, and viewport-rectangle text for a dragged region. `annotationScreenshots` may also include, ask through a native prompt for, or never include a screenshot of the selected element or region; accepted captures are bounded PNGs and enter the active composer as an image beside the text annotation. Missing geometry, a failed or oversized capture, a tab switch, or a navigation race degrades safely to text-only or drops stale evidence.

`historyAccessPolicy` governs only model-facing `browser_history_search`, not the user's Settings history manager. `allow` returns at most 20 title/URL matches from the bounded app-owned ledger, `block` denies before Electron is acquired or started, and `ask` requires an `allowed-once` Host approval bound to the query and tool call before Electron is acquired or started; an unavailable approval service fails closed.

Full CDP is effective only when the deployment's `allowFullCdpAccess` ceiling and the user's disabled-by-default `fullCdpAccess` opt-in both allow it. The desktop requires a native risk confirmation before persisting the opt-in, and every command or event read still requires a fresh `allowed-once` Host approval bound to the controlled tab, HTTP(S) origin, and requested operation. Electron rechecks the target before execution, excludes cross-target CDP domains, and bounds request and response data.

Electron persists its bounded management state in `browser-management.json`: at most 1,000 navigation-history entries, 500 download-ledger entries, and 500 exact-origin site overrides. A site override stores top-level navigation `access` and camera/microphone `media` decisions as `allow` or `block`; it does not override download/upload policy or filter subresources. Removing a history or download entry removes only its app-owned ledger row, never an open tab's navigation history or a downloaded file.

Clearing browser data accepts `all` (the default for older callers), `history`, `site-data`, `cache`, or `downloads`. The selected scope clears Chromium data where applicable, clears every open tab's navigation history for `all` or `history`, and updates the matching app-owned history/download ledger. It deliberately retains durable Browser settings, site overrides, downloaded files, and the encrypted autofill vault. Desktop Settings exposes password-free login metadata and allowlisted contact fields only when Electron secure storage and the current preload management methods are available; saved passwords never return to the renderer. Older preloads and unavailable or failed secure storage keep both managers disabled and fail closed.

## Layout

```
electron-app/main.cjs         window + chrome/page WebContentsViews + NDJSON loop over fd 0
electron-app/chrome.html      static tab strip, omnibox, and agent status HUD
electron-app/chrome-preload.cjs sandboxed chrome IPC wiring
electron-app/preload.entry.js source of the preload bundle
electron-app/preload.cjs      committed build output — what Electron actually loads
third-party/page-agent/       upstream-pinned PageAgent source submodule
vite.preload.config.js        bundles the upstream runtime and preload into one CJS file
src/                          the Node half: service, child process, types
```

`electron-app/*` runs in Electron, not in the harness's Node process, and is published as-is rather than built by tsdown.

In standalone use, `BrowserSessionService` talks to its Electron child in NDJSON over stdin/stdout — one JSON object per line, `{id, method, args}` out and `{id, ok, result|error}` back. No port is involved, and the channel dies with the process; `main.cjs` therefore sends diagnostics to stderr because stdout is the protocol. The desktop shell instead hosts the same controller in its Electron main process and exposes only narrow, validated preload/IPC operations for configuration and browser management.

## Checking out PageAgent

`pnpm install` links `@page-agent/core` and `@page-agent/page-controller` from this package's [`third-party/page-agent`](third-party/page-agent) git submodule. An empty checkout produces `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.

From the repository root:

```sh
git submodule update --init packages/browser/browser-electron/third-party/page-agent
```

When GitHub does not advertise the gitlink SHA (`not our ref`), check out the public tag that matches the lockfile (`v1.12.2`):

```sh
rm -rf packages/browser/browser-electron/third-party/page-agent
git clone --branch v1.12.2 --depth 1 https://github.com/alibaba/page-agent.git packages/browser/browser-electron/third-party/page-agent
```

Then rerun `pnpm install`. The licence is in [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).

## Rebuilding the preload

`electron-app/preload.cjs` is committed. Regenerate it only when the upstream submodule or `preload.entry.js` changes:

```
pnpm --filter @hydra/harness-browser-electron run build:preload
```

Populate the submodule before that rebuild; see [Checking out PageAgent](#checking-out-pageagent).

## Installing the Electron binary behind a proxy

`electron` is an `optionalDependency`: without it the plugin still loads and every call fails with `BROWSER_UNAVAILABLE`, and the rest of the harness is unaffected. Its postinstall downloads a ~200 MB binary through `@electron/get`, which uses undici's `fetch` and therefore **ignores npm's `proxy` / `https-proxy` settings**. Behind a corporate proxy the download needs the environment variables:

```
HTTPS_PROXY=http://localhost:3128 HTTP_PROXY=http://localhost:3128 \
  node node_modules/.pnpm/electron@43.4.1/node_modules/electron/install.js
```

The postinstall also needs `electron: true` under `allowBuilds` in `pnpm-workspace.yaml`; `strictDepBuilds` blocks it otherwise.

## Security

The controlled view runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload never calls `contextBridge`, so `ipcRenderer` never leaves module scope and a hostile document has no handle on the control channel. The window is headed by default: the user watches what the agent does.

**Navigation is policy-controlled at every new top-level destination.** Direct tool/tab loads, the omnibox, and the configured home page check before `loadURL`; popups check before adoption; and Chromium events cover page links and redirects. An exact-origin site block takes precedence over same-origin access and vetoes Back, Forward, and Reload; otherwise same-origin HTTP(S) navigation proceeds automatically, a cross-origin destination uses its exact-origin override or the default navigation policy, and non-HTTP(S) destinations fail closed. The `ask` policy presents Allow once, Always allow, and Block in the owning chat through `ctx.userQuestions`. Electron holds the main-frame network request until the answer arrives, preserving POST bodies and redirects. Missing answerers, skipped or custom answers, owner disconnection, action cancellation, and document replacement deny the pending request. Browser action deadlines pause during this human wait. Camera and microphone requests use the same chat path.

**Downloads are decided before Chromium writes them.** The default download policy can allow, ask, or block; accepted downloads receive a unique target path under the configured or system Downloads directory, and `askWhereToSave` opens the native save dialog. Only camera and microphone requests can be granted through an exact-origin media override or chat answer; blocking media never grants site access and reloads matching documents, including frames, before the change returns. Every other permission, device-permission, and display-capture request fails closed.

**The profile carries real SSO cookies.** `userDataDir` defaults to `<harness-home>/browser-profile` and persists, which is the point — logging in once should survive the session. Set `persistSessionCookies: true` when the profile must also retain otherwise session-only SSO cookies: Hydra harness promotes them into Chromium's encrypted cookie store for 30 days and flushes the store before a harness-owned exit. It also means a prompt-injected page can steer the agent into acting as the signed-in user against any site that profile is authenticated to. This is the same class of risk as the deferred SSRF protection on `web_fetch` ([web capability seam](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md#deferred-work)): do not enable the embedded browser where an untrusted page can be reached with a profile authenticated to sensitive internal systems. Screenshot capture refuses Browser chrome, background tabs, and non-HTTP(S) pages, but it can still record sensitive pixels visible in the selected signed-in page.

Set `homeUrl` only in the user's profile patch when a deployment has one trusted default site; it does not replace Obsidian knowledge as the source of application-specific routes.

**File selection is fail-closed.** `upload_file` accepts only an absolute, readable regular-file path that a direct user wrote as a standalone or quoted literal in the current open turn. After those checks, `BrowserSessionService` enforces the Host-owned upload policy by allowing, rejecting, or requesting approval bound to the exact file, current HTTP(S) origin, tab, input index, and tool call. Electron verifies the same tab and origin before and after resolving the indexed HTML `<input type="file">`, then selects the file through Chromium's DOM protocol without page JavaScript. A workflow consumer remains responsible for restricting which configured domain may invoke it.

## Model Experience

### Indirect consumer

#### What the model sees

Nothing directly. This package registers no prompt and no tool; `@hydra/harness-tool-browser` owns the visible schemas, the DOM-format prompt section, and the result text.

#### Token effect

None directly. A page's text DOM stays process-local until a consumer returns a bounded result.

#### KV Cache effect

No direct invalidation; the named consumer owns request-prefix changes.

## Known Limitations and Deferred Work

An ask-policy website or media request requires a connected owning chat. Unowned desktop browsing fails closed; configure exact-site access in Browser settings when browsing outside an agent session. Download, annotation-screenshot, and elevated-risk settings prompts retain their existing native presentation.

- No screenshot-based page control, full-page capture, crop, or iframe traversal. The visual read captures only the selected tab's viewport and supplies no coordinates; actions still use the numbered text DOM.
- `execute_javascript` is experimental and host-gated by `experimentalScriptExecution`; it runs in PageAgent's isolated document world, cannot access page-world JavaScript globals, and can mutate the current page.
- File upload supports an observed HTML file input, but not a proxy button or hidden chooser control.
- Sessions are process-local: a harness restart loses the window, though the profile keeps the login.
- One agent owns one Chromium profile and window. Parallelism is across that window's isolated tabs; use separate agents when work requires independent browser profiles or windows.
