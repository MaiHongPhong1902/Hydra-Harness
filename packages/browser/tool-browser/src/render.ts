/**
 * The browser tools' output shape, its bounding, and its presentation. Pure
 * over its inputs: the presenters run again during session-log replay, where
 * no browser exists.
 */

import type { BrowserOutcome, BrowserTabState } from '@hydra/harness-browser-electron'
import type { GenericCallView } from '@hydra/harness-tools'

/** Default cap on the element list one browser call returns. */
export const DEFAULT_MAX_STATE_CHARS = 16_000

/** Appended when {@link toValue} cut the element list. */
export const TRUNCATION_NOTICE
  = '(Element list truncated. Scroll to a narrower part of the page to see the rest.)'

/**
 * One browser tool's output value: what the action did, then what the page
 * looks like afterwards. `action` is absent for a plain state read, which took
 * no action to report.
 */
export interface BrowserToolValue {
  /** The action's own report, omitted by `browser_state`. */
  action?: { success: boolean; message: string }
  /** URL after the action. */
  url: string
  /** Document title after the action. */
  title: string
  /** Page info and the scroll-position hint above the element list. */
  header: string
  /** The numbered element list, cut to the configured cap. */
  content: string
  /** The scroll-position hint below the element list. */
  footer: string
  /** Controlled tabs in the browser window. */
  tabs: BrowserTabState[]
  /** Tab whose page produced this value and whose element indices are valid. */
  tabId: number
  /** Tab currently selected in the visible browser chrome. */
  activeTabId: number
  /** Whether the bounded readiness check completed. */
  settled: boolean
  /** Host capture timestamp. */
  capturedAt: string
  /** Whether `content` was cut. */
  truncated: boolean
}

/**
 * Bound a seam outcome into the model-facing value.
 *
 * Only `content` is cut. The header and footer are short, fixed-shape, and are
 * the only way the model learns there is more page to scroll to — dropping them
 * to fit a cap would hide exactly the thing that makes the cut recoverable.
 * @param outcome - what the seam reported.
 * @param maxStateChars - cap on the element list.
 * @returns the bounded value.
 */
export function toValue(outcome: BrowserOutcome, maxStateChars: number): BrowserToolValue {
  const { state } = outcome
  const content = state.content.slice(0, maxStateChars)
  return {
    ...outcome.action === undefined ? {} : { action: outcome.action },
    url: state.url,
    title: state.title,
    header: state.header,
    content,
    footer: state.footer,
    tabs: state.tabs,
    tabId: state.tabId,
    activeTabId: state.activeTabId,
    settled: state.settled,
    capturedAt: state.capturedAt,
    truncated: content.length !== state.content.length,
  }
}

/**
 * Format one browser value as the model-facing text block.
 * @param value - the bounded tool output.
 * @returns the action report, if any, above the page as text.
 */
export function formatBrowserOutput(value: BrowserToolValue): string {
  const tabs = `Open tabs:\n${value.tabs.map(tab => `- [${tab.id}] ${tab.active ? '(active) ' : ''}${tab.title} — ${tab.url} (${tab.status})`).join('\n')}`
  const target = `Snapshot tab: [${value.tabId}]${value.tabId === value.activeTabId ? '' : ' (background)'}`
  const page = `${tabs}\n${target}\n\n${value.header}\n${value.content}\n${value.footer}`
  const bounded = value.truncated ? `${page}\n\n${TRUNCATION_NOTICE}` : page
  const body = value.settled
    ? bounded
    : `Page readiness timed out; this snapshot is transient evidence, not a final UI verdict.\n\n${bounded}`
  return value.action === undefined ? body : `${value.action.message}\n\n${body}`
}

/**
 * Pending-call presentation. Pure over `args` because replay has no browser.
 * @param title - the short label for this call, built by the caller from args.
 * @param rawInput - the salient argument to show expanded, if any.
 * @returns the generic card shown while the call runs.
 */
export function presentBrowserCall(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'execute', ...rawInput === undefined ? {} : { rawInput } }
}
