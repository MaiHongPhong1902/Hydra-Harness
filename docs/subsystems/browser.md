# Embedded Browser

The embedded-browser seam: one Electron window per `Agent`, started on that agent's first action and closed with it, driven through [page-agent](https://github.com/alibaba/page-agent)'s `PageController` running in each controlled tab's preload. Two packages — the seam and process owner ([bh-browser-electron](../../packages/browser/browser-electron), `ctx.browsers`), and the Consumer ([bh-tool-browser](../../packages/browser/tool-browser), the `browser_*` tool schemas and the DOM-format prompt section). Browsing is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/browser/browser-electron/src/types.ts`](../../packages/browser/browser-electron/src/types.ts)

## Why there is no provider registry

Unlike [web.md](web.md), this seam has exactly one implementation and names it in the package: `bh-browser-electron` both defines `ctx.browsers` and owns the Electron process behind it. A single-purpose plugin stays one package until a second backend actually exists; splitting the definition out now would be an interface with one implementation.

The modality is text, not pixels. `PageController` turns a targeted live DOM into a numbered element list (`[12]<button>Save</button>`) and acts by index, so no screenshot and no vision model is involved anywhere in the loop. The native chrome and the model share one controlled-tab inventory and a functional omnibox.

## Page state

```ts type-equiv
/** Text-DOM snapshot of the controlled page, as PageController renders it. */
interface BrowserState {
  /** Address currently loaded in the controlled view. */
  url: string
  /** Document title. */
  title: string
  /** Page metrics and scroll position, above the element listing. */
  header: string
  /** Indexed interactive elements, `[12]<button>Save</button>` per line. */
  content: string
  /** Scroll hint below the element listing. */
  footer: string
  /** Every controlled tab in this Electron window. */
  tabs: BrowserTabState[]
  /** Tab whose document supplied this snapshot and whose indices are valid. */
  tabId: number
  /** Tab currently selected in the visible browser chrome. */
  activeTabId: number
  /** True when the requested bounded page-readiness wait completed. */
  settled: boolean
  /** Host timestamp for evidence ordering. */
  capturedAt: string
}
```

Each `BrowserTabState` in `tabs` has a stable `id`, `url`, `title`, `status` (`loading` or `complete`), and `active` flag.

`header`, `content`, and `footer` arrive already formatted by `PageController`; the seam does not reshape them. Bounding `content` and joining the three into model-facing text is the consumer's job, because the cap is a deployment choice.

## Actions

```ts type-equiv
/**
 * One page-local or tab-lifecycle action accepted by the browser seam.
 * `tabId` pins a page-local action to one tab; omission captures the selected
 * tab when Electron receives it.
 */
type BrowserAction =
  | ((
    | { method: 'get_browser_state' }
    | { method: 'navigate'; url: string }
    | { method: 'back' }
    | { method: 'press'; key: string }
    | { method: 'click_element'; index: number }
    | { method: 'upload_file'; index: number; filePath: string }
    | { method: 'input_text'; index: number; text: string }
    | { method: 'select_option'; index: number; text: string }
    | { method: 'scroll'; down: boolean; numPages: number; pixels?: number; index?: number }
    | { method: 'scroll_horizontally'; right: boolean; pixels: number; index?: number }
    | { method: 'wait'; seconds: number }
    | { method: 'execute_javascript'; script: string }
    | { method: 'page_agent_run'; task: string }
    | { method: 'page_agent_status' }
    | { method: 'page_agent_stop' }
  ) & { tabId?: number })
  | { method: 'open_new_tab'; url?: string }
  | { method: 'switch_to_tab'; tabId: number }
  | { method: 'close_tab'; tabId: number }
```

The wire names are page-agent's own where possible. `navigate`, `back`, `press`, bounded `wait`, and tab actions are answered by the Electron main process; DOM actions reach the targeted view's preload and land in `PageController`. `execute_javascript` is host-gated and runs only in PageController's isolated document world.

An action without `tabId` is a window-wide barrier and captures the selected tab when Electron receives it. Explicit targets are serialized per tab and may overlap across different tabs; switching the visible tab does not retarget or cancel them. Navigation, renderer loss, or tab closure rejects only the affected tab's calls.

```ts type-equiv
/** One action's report plus the page as it stands afterwards. */
interface BrowserOutcome {
  /** Absent for a plain state read, which does nothing to the page. */
  action?: ActionResult
  state: BrowserState
}
```

Every `perform` ends with a state read for the same explicit target, or for the selected tab after a lifecycle action. The trailing snapshot is load-bearing rather than convenient: `PageController` assigns element indices while it builds the tree, so an action that did not re-read would leave the caller holding indices that address nothing. Navigation, state reads, and tab transitions wait boundedly for Chromium to be idle and usable SPA content to appear; an exhausted wait returns `settled: false` rather than treating an empty shell as final evidence. A navigation, renderer crash, tab close, or window close invalidates the affected indices; in-flight calls reject rather than resolving against a document that no longer exists.

An action the page rejects is not an error. `{success: false, message}` is a fact the caller can act on — a missing index, a `select` with no such option — and only the transport and the process lifecycle throw.

## Errors

`BrowserError` carries a stable code so a caller can route on the failure without parsing prose.

```ts type-equiv
/** Machine-routable embedded-browser failures. */
type BrowserErrorCode =
  /** Electron is not installed — the embedded browser is an optional capability. */
  | 'BROWSER_UNAVAILABLE'
  /** The child never reported ready, or died during startup. */
  | 'BROWSER_LAUNCH_FAILED'
  /** The window closed or the child exited while work was outstanding. */
  | 'BROWSER_GONE'
  /** The child accepted the request and never answered. */
  | 'BROWSER_TIMEOUT'
  /** The service is tearing down and will not start new work. */
  | 'BROWSER_DISPOSING'
```

`BROWSER_UNAVAILABLE` is the ordinary case on a host without the optional `electron` package: the plugin still loads and the tools still register, so nothing else in the harness changes shape. `BROWSER_LAUNCH_FAILED` carries the child's stderr tail, because a GUI-less host fails at exactly this point and the reason is in that output.

## The transport

The parent talks to the child in NDJSON over stdin/stdout — one JSON object per line, `{id, method, args}` out and `{id, ok, result|error}` back. There is no port to ask for, no `EADDRINUSE`, no `/api` trust fence to cross, and the channel dies with the process. The cost is that the Electron main process may never write to stdout: that stream *is* the channel, so every diagnostic goes to stderr.

## Security

The controlled view runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and the preload never calls `contextBridge` — `ipcRenderer` never leaves module scope, so a hostile document has no handle on the control channel. The window is headed by default: the user watches what the agent does.

The browser follows Chromium navigation: `browser_navigate` opens any absolute `http:` or `https:` URL without origin approval, and page redirects and links are not filtered by the harness. A `window.open()` page is adopted into a controlled tab and appears in the next Browser state.

**The profile carries real SSO cookies** and persists across sessions by design, so a prompt-injected page can steer the agent into acting as the signed-in user on any site that profile is authenticated to. This is the same class of exposure as the deferred SSRF protection on `web_fetch`. Do not enable the embedded browser where an untrusted page can be reached with a profile authenticated to sensitive internal systems.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowsers--browsersessionservice"></a>

### `ctx.browsers` — `BrowserSessionService`

One Electron window per agent, started lazily and closed with its owner.

```ts cordis-catalog
/**
 * Do one thing to an owner's page and report the page afterwards.
 *
 * The trailing state read is not a convenience: PageController indexes
 * elements while building the tree, so the snapshot both answers the caller
 * and leaves the next action addressable. Explicit targets are ordered per
 * tab and may overlap across tabs; implicit and lifecycle actions are barriers.
 * @param owner - agent whose window this is; its first call starts one.
 * @param action - what to do, in page-agent's own vocabulary.
 * @returns the action's report, omitted for a plain state read, plus the state.
 */
async perform(owner: Agent, action: BrowserAction): Promise<BrowserOutcome>

/**
 * Close one owner's window now, if it has one.
 * @param owner - agent whose window to close.
 * @returns true when a window was open and is now closed.
 */
async close(owner: Agent): Promise<boolean>
```

Types: [Agent](core.md)

Source: [`packages/browser/browser-electron/src/index.ts`](../../packages/browser/browser-electron/src/index.ts)
<!-- END GENERATED cordis-surface -->
