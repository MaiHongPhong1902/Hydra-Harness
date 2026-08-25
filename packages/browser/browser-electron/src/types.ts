/**
 * Wire vocabulary shared by the service, the Electron child, and consumers.
 * Low-level method names remain PageAgent's own; its upstream engine runs in
 * the controlled preload while BH owns its controls.
 * @module @bosch/bh-browser-electron/types
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

/** Text-DOM snapshot of the controlled page, as PageController renders it. */
export interface BrowserState {
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

/** Outcome of one action, as PageController reports it. */
export interface ActionResult {
  success: boolean
  message: string
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

/** Error carrying a stable {@link BrowserErrorCode}. */
export class BrowserError extends Error {
  constructor(message: string, readonly code: BrowserErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserError'
  }
}
