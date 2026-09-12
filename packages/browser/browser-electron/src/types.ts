/**
 * Wire vocabulary shared by the service, the Electron child, and consumers.
 * Low-level method names remain PageAgent's own; its upstream engine runs in
 * the controlled preload while Hydra owns its controls.
 * @module @hydra/harness-browser-electron/types
 */

/** One controlled tab exposed to the model. */
export type BrowserTabState = {
  /** Stable id used by tab actions for this browser window. */
  id: number
  /** Address currently loaded in the tab. */
  url: string
  /** Last document title reported by Chromium. */
  title: string
  /** Whether Chromium is still loading the tab's main frame. */
  status: 'loading' | 'complete'
  /** Whether subsequent page actions target this tab. */
  active: boolean
}

/** Accessibility snapshot of the controlled page with stable action refs. */
export interface BrowserState {
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

/** Transient PNG of the selected controlled page's visible viewport. */
export interface BrowserScreenshot {
  /** Declared image type; Electron always encodes PNG. */
  mediaType: 'image/png'
  /** Canonical base64 PNG, consumed before a model-facing result is persisted. */
  data: string
  /** Exact encoded PNG byte length. */
  bytes: number
  /** Captured image width after bounding. */
  width: number
  /** Captured image height after bounding. */
  height: number
  /** Selected tab captured by Electron. */
  tabId: number
  /** HTTP(S) page address captured by Electron. */
  url: string
  /** Document title at capture completion. */
  title: string
  /** Host timestamp for evidence ordering. */
  capturedAt: string
}

/** Outcome of one action, as PageController reports it. */
export interface ActionResult {
  success: boolean
  message: string
}

/** One bounded history-search result exposed to an approved model call. */
export interface BrowserHistorySearchEntry {
  url: string
  title: string
  visitedAt: string
}

/** JSON value accepted in bounded CDP parameters and results. */
export type BrowserJsonValue = null | boolean | number | string | BrowserJsonValue[] | {
  [key: string]: BrowserJsonValue
}

/** One bounded raw CDP command result. */
export interface BrowserCdpCommandResult {
  method: string
  result: Record<string, BrowserJsonValue>
}

/** One bounded CDP event retained for cursor-based reads. */
export interface BrowserCdpEvent {
  sequence: number
  method: string
  params: Record<string, BrowserJsonValue>
  receivedAt: string
}

/** Cursor page over the current tab's bounded CDP event ring. */
export interface BrowserCdpEventPage {
  events: BrowserCdpEvent[]
  nextSequence: number
}

/** One field a Hydra fill action types, resolved by index or visible name. */
export interface BrowserFillField {
  /** Element index from the latest snapshot for this tab. */
  index?: number
  /** Visible label, accessible name, placeholder, or id when index is omitted. */
  name?: string
  /** Text that replaces the field's current value. */
  text: string
}

/**
 * One page-local or tab-lifecycle action accepted by the browser seam.
 * `tabId` pins a page-local action to one tab; omission captures the selected
 * tab when Electron receives it.
 */
export type BrowserAction =
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

/** One action's report plus the page as it stands afterwards. */
export interface BrowserOutcome {
  /** Absent for a plain state read, which does nothing to the page. */
  action?: ActionResult
  state: BrowserState
}

/** Machine-routable embedded-browser failures. */
export type BrowserErrorCode =
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

/** Error carrying a stable {@link BrowserErrorCode}. */
export class BrowserError extends Error {
  constructor(message: string, readonly code: BrowserErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserError'
  }
}
