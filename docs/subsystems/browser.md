# Embedded Browser

The embedded-browser seam: one Electron window per `Agent`, started on that agent's first action and closed with it, driven through [page-agent](https://github.com/alibaba/page-agent)'s `PageController` running in each controlled tab's preload. Two packages — the seam and process owner ([@hydra/harness-browser-electron](../../packages/browser/browser-electron), `ctx.browsers`), and the Consumer ([@hydra/harness-tool-browser](../../packages/browser/tool-browser), the `browser_*` tool schemas and the accessibility-snapshot prompt section). Browsing is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/browser/browser-electron/src/types.ts`](../../packages/browser/browser-electron/src/types.ts)

## Why there is no provider registry

Unlike [web.md](web.md), this seam has exactly one implementation and names it in the package: `@hydra/harness-browser-electron` both defines `ctx.browsers` and owns the Electron process behind it. A single-purpose plugin stays one package until a second backend actually exists; splitting the definition out now would be an interface with one implementation.

The page-control modality is an accessibility snapshot, not pixels. Chromium Accessibility.getFullAXTree supplies roles, accessible names, and states, joined to private PageController action refs (`[12]<button>Save</button>`), while `PageController` acts on the underlying element by index. A user-created Browser annotation is a separate composer path that may attach a bounded screenshot of a selected element or viewport region. The native chrome and the model share one controlled-tab inventory and a functional omnibox.

Website and media permission requests use the owning chat through `ctx.userQuestions`; the Electron owner enforces the answer before continuing. The [package README](../../packages/browser/browser-electron/README.md#security) defines the policy and cancellation behavior.

## Context cost

Ordinary browser actions keep a per-tab revision and return a structural diff when fewer than half the indexed lines change. Full state reads and navigation remain full snapshots; an empty diff records the revision while retaining the previous indexes. The offline six-scenario benchmark and committed measurements live in [examples/acp-agent/browser-bench](../../examples/acp-agent/browser-bench).

## Page state

```ts type-equiv
/** Accessibility snapshot of the controlled page with stable action refs. */
interface BrowserState {
  /** Address currently loaded in the controlled view. */
  url: string
  /** Document title. */
  title: string
  /** Page metrics and scroll position, above the element listing. */
  header: string
  /** Indexed accessibility nodes, `[12]<button>Save</button>` per line. */
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

`header`, `content`, and `footer` arrive already formatted by the Hydra preload. `content` starts from roles, accessible names, and selected states, retains bounded `id`/`href` compatibility metadata, and includes plain page text not represented by an indexed control. `@hydra/harness-tool-browser` omits only explicitly ignored accessibility nodes, ranks again, then cuts only `content` to the full (`browser_state` / `browser_navigate`) or compact (~4k) budget. Indices stay PageController's because the model projection never renumbers the seam's selector map.

## Actions

```ts type-equiv
/** One field a Hydra fill action types, resolved by index or visible name. */
interface BrowserFillField {
  /** Element index from the latest snapshot for this tab. */
  index?: number
  /** Visible label, accessible name, placeholder, or id when index is omitted. */
  name?: string
  /** Text that replaces the field's current value. */
  text: string
}
```

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
    | { method: 'forward' }
    | { method: 'press'; key: string }
    | { method: 'click_element'; index?: number; name?: string }
    | { method: 'hover_element'; index?: number; name?: string }
    | { method: 'drag_element'; startIndex: number; endIndex: number }
    | { method: 'drop'; index: number; filePaths: string[]; data: Record<string, string> }
    | { method: 'resize'; width: number; height: number }
    | { method: 'handle_dialog'; accept: boolean; promptText?: string }
    | { method: 'console_messages'; level: 'error' | 'warning' | 'info' | 'debug' }
    | { method: 'network_requests'; includeStatic: boolean }
    | { method: 'network_request'; index: number; part?: 'request-headers' | 'request-body' | 'response-headers' | 'response-body' }
    | { method: 'upload_file'; index: number; filePath: string }
    | { method: 'input_text'; index?: number; name?: string; text: string }
    | { method: 'select_option'; index?: number; name?: string; text: string }
    | { method: 'select_text'; index?: number; name?: string; startX?: number; startY?: number; endX?: number; endY?: number; duration?: number; start_x?: number; start_y?: number; end_x?: number; end_y?: number }
    | { method: 'find_element'; query: string }
    | { method: 'fill_fields'; fields: BrowserFillField[] }
    | { method: 'scroll'; down: boolean; numPages: number; pixels?: number; index?: number }
    | { method: 'scroll_horizontally'; right: boolean; pixels: number; index?: number }
    | { method: 'wait'; seconds: number }
    | { method: 'wait_for'; seconds: number; text?: string; textGone?: string }
    | { method: 'execute_javascript'; script: string }
    | { method: 'page_agent_run'; task: string }
    | { method: 'page_agent_status' }
    | { method: 'page_agent_stop' }
  ) & { tabId?: number })
  | { method: 'open_new_tab'; url?: string }
  | { method: 'switch_to_tab'; tabId: number }
  | { method: 'close_tab'; tabId: number }
```

The wire names are page-agent's own where possible. `navigate`, `back`, `forward`, `press`, bounded `wait`, and tab actions are answered by the Electron main process; Page actions — including Hydra-owned `find_element` and `fill_fields` — reach the targeted view's preload and land in `PageController`. Click, type, and select accept an index or a visible `name`. `execute_javascript` is host-gated and runs only in PageController's isolated document world. `page_agent_*` starts the vendored ReAct engine only when requested explicitly.

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

## Settings and profile management

The durable `browser-electron` namespace covers agent control; separate public-web and loopback URL destinations; annotation screenshots; download location and prompting; navigation, download, upload, and model-history decisions; and Full CDP opt-in. Agent control defaults on, both URL classes default to Hydra harness, annotation screenshots default to include, Full CDP defaults off, and every `allow | ask | block` policy defaults to `ask`.

`BrowserSessionService` checks `controlEnabled` at the shared action seam and pushes native-relevant setting changes to every active Electron controller. Turning control off stops detached PageAgent loops and makes their racing model requests fail with `BROWSER_DISABLED`. Upload always requires a user-literal, absolute, readable regular file; `block` rejects and `ask` delegates to `ctx.approval` with the exact file, HTTP(S) origin, tab, input index, tool-call id, and cancellation signal. Model history search has its own `allow | ask | block` policy and returns at most 20 ledger matches only after any `allowed-once` approval. Every policy denial reports `BROWSER_POLICY_DENIED`.

The desktop intercepts trusted-renderer HTTP(S) links and routes non-loopback and loopback URLs independently to a controlled Hydra harness tab or the system browser; the Hydra harness route still passes navigation policy. Quick annotate emits bounded element metadata. Interactive Annotate emits that metadata for a click or short drag, or bounded viewport-rectangle metadata for a dragged region. The annotation setting includes, asks for, or omits the corresponding bounded PNG that the conversation queues beside the text context.

Full CDP is available only below the deployment's organization ceiling and after a disabled-by-default user opt-in with native risk confirmation. Even then, every raw command or event read needs a fresh approval bound to its tab, origin, and operation, and Electron rejects cross-target domains and stale targets. Disabling either gate removes the model-facing CDP tools.

The Electron owner persists `browser-management.json` beside the Chromium profile. It bounds navigation history at 1,000 entries, the download ledger at 500 entries, and exact canonical HTTP(S)-origin site overrides at 500 entries; each override stores top-level navigation `access` and camera/microphone `media` as `allow` or `block`, without overriding download/upload policy or filtering subresources. Removing a history or download entry changes only its app-owned ledger, never an open tab's navigation history or a downloaded file. Clearing browser data runs Chromium's data clear, clears open-tab navigation history, and empties the history and download ledgers while retaining durable Browser settings, site overrides, and downloaded files. Desktop Settings exposes password-free login metadata and allowlisted contact fields only when Electron secure storage and the current preload management methods are available; saved passwords never return to the renderer. Older preloads and unavailable or failed secure storage keep both managers disabled and fail closed.

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
  /** User settings currently disable agent control of the embedded browser. */
  | 'BROWSER_DISABLED'
  /** One Browser permission setting denied this action. */
  | 'BROWSER_POLICY_DENIED'
```

`BROWSER_UNAVAILABLE` is the ordinary case on a host without the optional `electron` package: the plugin still loads and the tools still register, so nothing else in the harness changes shape. `BROWSER_LAUNCH_FAILED` carries the child's stderr tail, because a GUI-less host fails at exactly this point and the reason is in that output. `BROWSER_POLICY_DENIED` identifies an upload, sensitive-history search, or Full CDP operation that settings, organization policy, missing approval support, or a non-`allowed-once` decision denied.

## The transport

In standalone use, `BrowserSessionService` talks to the Electron child in NDJSON over stdin/stdout — one JSON object per line, `{id, method, args}` out and `{id, ok, result|error}` back. There is no port to ask for, no `EADDRINUSE`, and the channel dies with the process; stdout is the protocol, so diagnostics go to stderr. The desktop app instead hosts the same browser controller inside its Electron main process, routes renderer requests through narrow preload methods and validated IPC handlers, and calls the controller directly rather than starting a second browser child.

## Security

The controlled view runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and the preload never calls `contextBridge` — `ipcRenderer` never leaves module scope, so a hostile document has no handle on the control channel. The window is headed by default: the user watches what the agent does.

Every new top-level destination is policy-checked: direct tool/tab loads, the omnibox, and the configured home page check before `loadURL`; popups check before adoption; and Chromium's navigation events and main-frame network requests cover page links and redirects. An exact-origin site block takes precedence over same-origin access and vetoes Back, Forward, and Reload; otherwise same-origin HTTP(S) navigation proceeds automatically, non-HTTP(S) navigation is blocked, and each other destination uses its exact-origin `access` override or the default navigation policy. The `ask` policy offers Allow once, Always allow, and Block in the owning chat; remembered allow/block choices are persisted for that canonical origin.

Downloads are approved or blocked before Chromium writes them, receive a unique destination under the configured or system Downloads directory, and may open a native save dialog. Only camera and microphone media permission can be granted, by exact-origin override or chat answer; blocking media never grants site access and reloads every matching controlled document or frame before the update returns. Every other permission, device-permission, and display-capture request fails closed.

**The profile carries real SSO cookies** and persists across sessions by design, so a prompt-injected page can act as the signed-in user on any reachable site that profile is authenticated to. Navigation approval reduces accidental cross-origin movement but does not make an allowed or remembered origin trustworthy. This is the same class of exposure as the deferred SSRF protection on `web_fetch`; do not enable the embedded browser where untrusted content can share a profile authenticated to sensitive internal systems.

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
 * @param execution - tool-call identity and cancellation for browser actions and permissions.
 * @returns the action's report, omitted for a plain state read, plus the state.
 */
async perform( owner: Agent, action: BrowserAction, execution: BrowserExecutionContext = {}, ): Promise<BrowserOutcome>

/**
 * Capture the selected controlled page's visible viewport as a bounded PNG.
 * The base64 is transient: callers must consume it before persisting output.
 * @param owner - agent whose selected controlled tab is captured.
 * @param execution - tool-call identity and cancellation for the browsing approval.
 * @returns the bounded screenshot payload.
 */
async takeScreenshot(owner: Agent, execution: BrowserExecutionContext = {}): Promise<BrowserScreenshot>

/**
 * Search only the bounded app-owned history after applying the model-access policy.
 * @param owner - agent whose browser profile owns the history ledger.
 * @param query - case-insensitive title/URL text, from 1 to 256 characters.
 * @param execution - tool-call identity and cancellation for approval.
 * @returns matching title, URL, and visit-time metadata.
 */
async searchHistory( owner: Agent, query: string, execution: BrowserExecutionContext = {}, ): Promise<BrowserHistorySearchEntry[]>

/**
 * Send one approved, bounded CDP command to the exact controlled tab.
 * @param owner - agent whose controlled browser owns the target tab.
 * @param method - CDP method name.
 * @param params - JSON parameters for the method.
 * @param tabId - optional positive controlled-tab id; omission uses the selected tab.
 * @param execution - tool-call identity and cancellation for approval.
 * @returns the bounded method name and JSON result.
 */
async sendCdpCommand( owner: Agent, method: string, params: unknown, tabId: number | undefined, execution: BrowserExecutionContext = {}, ): Promise<BrowserCdpCommandResult>

/**
 * Read a bounded cursor page of events captured from an approved controlled tab.
 * @param owner - agent whose controlled browser owns the target tab.
 * @param options - cursor, page-size, method filter, and optional tab id.
 * @param execution - tool-call identity and cancellation for approval.
 * @returns the bounded events and the next cursor value.
 */
async readCdpEvents( owner: Agent, options: { afterSequence?: number; limit?: number; method?: string; tabId?: number }, execution: BrowserExecutionContext = {}, ): Promise<BrowserCdpEventPage>

/**
 * Close one owner's window now, if it has one.
 * @param owner - agent whose window to close.
 * @returns true when a window was open and is now closed.
 */
async close(owner: Agent): Promise<boolean>
```

Types: [Agent](core.md)

Source: [`packages/browser/browser-electron/src/index.ts`](../../packages/browser/browser-electron/src/index.ts)

<a id="browser-events"></a>

### `browser/*` events

<a id="browserfull-cdp-access--emit"></a>

#### `browser/full-cdp-access` — emit

The effective Full CDP gate changed after a user setting or deployment policy update; listeners may refresh model-facing CDP tool registration.

```ts cordis-catalog
/**
 * The effective Full CDP gate changed after a user setting or deployment
 * policy update; listeners may refresh model-facing CDP tool registration.
 * @mode emit
 * @param enabled - whether the organization ceiling and user opt-in both allow CDP.
 */
'browser/full-cdp-access'(enabled: boolean): void
```

Source: [`packages/browser/browser-electron/src/index.ts`](../../packages/browser/browser-electron/src/index.ts)
<!-- END GENERATED cordis-surface -->
