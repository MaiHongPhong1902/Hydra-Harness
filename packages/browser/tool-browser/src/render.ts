/**
 * The browser tools' output shape, its bounding, and its presentation. Pure
 * over its inputs: the presenters run again during session-log replay, where
 * no browser exists.
 */

import type { BrowserOutcome, BrowserTabState } from '@hydra/harness-browser-electron'
import type { GenericCallView } from '@hydra/harness-tools'

/** Default cap on the element list one full state or navigate call returns. */
export const DEFAULT_MAX_STATE_CHARS = 16_000

/** Cap on the ranked element list after an action that is not a full state read. */
export const DEFAULT_COMPACT_STATE_CHARS = 4_000

/** Appended when {@link toValue} cut the element list. */
export const TRUNCATION_NOTICE
  = '(Element list truncated. Scroll to a narrower part of the page to see the rest.)'

/** Appended when the trailing snapshot used the compact action budget. */
export const COMPACT_NOTICE
  = '(Compact snapshot after the action. Call browser_state for the full element list.)'

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
  /** The numbered element list, ranked then cut to the configured cap. */
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
  /**
   * Whether this value used the compact action budget. Compact results still
   * carry valid indices for the next call; `browser_state` is the full list.
   */
  compact: boolean
}

/** Options that select the full or compact trailing snapshot. */
export interface BrowserValueOptions {
  /** True after an action that is not `browser_state` or `browser_navigate`. */
  compact?: boolean
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea'])
const INDEXED_LINE = /^(\t*)(\*)?\[(\d+)\]<([a-z0-9-]+)/iu

/**
 * Rank one snapshot so newly appeared and typical form controls survive a
 * character cap. Indices stay PageController's; only line order changes.
 * @param content - the element list as PageController rendered it.
 * @returns the same lines, stable-sorted by usefulness then original order.
 */
export function rankElementList(content: string): string {
  if (content.length === 0) return content
  return content.split('\n')
    .map((line, order) => ({ line, order, rank: lineRank(line) }))
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map(entry => entry.line)
    .join('\n')
}

function lineRank(line: string): number {
  const match = INDEXED_LINE.exec(line)
  if (match === null) return 3
  if (match[2] === '*') return 0
  const tag = match[4]
  if (tag !== undefined && INTERACTIVE_TAGS.has(tag.toLowerCase())) return 1
  return 2
}

/**
 * Compress PageController's header to the title line, a short viewport/scroll
 * summary, and the above-the-fold hint. Full headers stay on `browser_state`.
 * @param header - the three-block header from a BrowserState.
 * @returns a shorter header that still names the page and leftover scroll.
 */
export function compactHeader(header: string): string {
  const lines = header.split('\n').map(line => line.trimEnd())
  const title = lines.find(line => line.startsWith('Current Page:')) || lines[0] || ''
  const info = lines.find(line => line.startsWith('Page info:'))
  const hint = [...lines].reverse().find(line =>
    line.includes('pixels above') || line === '[Start of page]',
  )
  return [title, info === undefined ? undefined : shortenPageInfo(info), hint]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join('\n')
}

function shortenPageInfo(info: string): string {
  const viewport = /(\d+x\d+)px viewport/u.exec(info)
  const above = /([\d.]+) pages above/u.exec(info)
  const below = /([\d.]+) pages below/u.exec(info)
  const parts = [
    viewport?.[1] === undefined ? undefined : `${viewport[1]} viewport`,
    above === null || Number(above[1]) <= 0 ? undefined : `${above[1]} pages above`,
    below === null || Number(below[1]) <= 0 ? undefined : `${below[1]} pages below`,
  ].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? info : parts.join(', ')
}

function formatTabs(tabs: readonly BrowserTabState[], compact: boolean): string {
  const tab = tabs.length === 1 ? tabs[0] : undefined
  if (compact && tab !== undefined) {
    return `Tab [${tab.id}] ${tab.active ? '(active) ' : ''}${tab.title} — ${tab.url}`
  }
  return `Open tabs:\n${tabs.map(entry =>
    `- [${entry.id}] ${entry.active ? '(active) ' : ''}${entry.title} — ${entry.url} (${entry.status})`).join('\n')}`
}

/**
 * Bound a seam outcome into the model-facing value.
 *
 * Content is ranked before the cap so a truncated list still prefers new and
 * interactive controls. Only `content` is cut. The header and footer are the
 * only way the model learns there is more page to scroll to.
 * @param outcome - what the seam reported.
 * @param maxStateChars - cap on a full element list.
 * @param options - compact trailing snapshots after ordinary actions.
 * @returns the bounded value.
 */
export function toValue(
  outcome: BrowserOutcome,
  maxStateChars: number,
  options: BrowserValueOptions = {},
): BrowserToolValue {
  const compact = options.compact === true
  const budget = compact ? Math.min(maxStateChars, DEFAULT_COMPACT_STATE_CHARS) : maxStateChars
  const { state } = outcome
  const ranked = rankElementList(state.content)
  const content = ranked.slice(0, budget)
  return {
    ...outcome.action === undefined ? {} : { action: outcome.action },
    url: state.url,
    title: state.title,
    header: compact ? compactHeader(state.header) : state.header,
    content,
    footer: state.footer,
    tabs: state.tabs,
    tabId: state.tabId,
    activeTabId: state.activeTabId,
    settled: state.settled,
    capturedAt: state.capturedAt,
    truncated: content.length !== ranked.length,
    compact,
  }
}

/**
 * Format one browser value as the model-facing text block.
 * @param value - the bounded tool output.
 * @returns the action report, if any, above the page as text.
 */
export function formatBrowserOutput(value: BrowserToolValue): string {
  const tabs = formatTabs(value.tabs, value.compact)
  const target = `Snapshot tab: [${value.tabId}]${value.tabId === value.activeTabId ? '' : ' (background)'}`
  const page = `${tabs}\n${target}\n\n${value.header}\n${value.content}\n${value.footer}`
  const notices = [
    ...value.truncated ? [TRUNCATION_NOTICE] : [],
    ...value.compact ? [COMPACT_NOTICE] : [],
  ]
  const bounded = notices.length === 0 ? page : `${page}\n\n${notices.join('\n')}`
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
