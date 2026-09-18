/**
 * Model-facing `browser_*` tools over the embedded-browser seam (`ctx.browsers`).
 * This package owns the schemas, the accessibility-snapshot prompt section, bounding, and
 * presentation; the seam owns the window and the page.
 * @module @hydra/harness-tool-browser
 */

import { Buffer } from 'node:buffer'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveBrowserArtifact, validateFilename } from './artifact.ts'
import type { Context } from '@hydra/cordis'
import z from '@hydra/schemastery'
import type { Agent } from '@hydra/harness-agent'
import { AttachmentId } from '@hydra/harness-attachment'
import type {
  BrowserAction, BrowserCdpCommandResult, BrowserCdpEventPage, BrowserHistorySearchEntry, BrowserScreenshot,
} from '@hydra/harness-browser-electron'
import type {} from '@hydra/harness-browser-electron'
import type { ContentBlock } from '@hydra/harness-llm'
import { defineTool } from '@hydra/harness-tools'
import type { ToolExecution } from '@hydra/harness-tools'
import type {} from '@hydra/harness-system-prompt'
import { BROWSER_PROMPT_NAME, BROWSER_PROMPT_ORDER, BROWSER_PROMPT_TEXT } from './prompt.ts'
import {
  DEFAULT_MAX_STATE_CHARS, contentHash, dropIgnoredNodes, formatBrowserOutput, presentBrowserCall, rankElementList, toValue,
} from './render.ts'
import type { BrowserToolValue } from './render.ts'

export { BROWSER_PROMPT_NAME, BROWSER_PROMPT_ORDER, BROWSER_PROMPT_TEXT } from './prompt.ts'
export {
  COMPACT_NOTICE, DEFAULT_COMPACT_STATE_CHARS, DEFAULT_MAX_STATE_CHARS, TRUNCATION_NOTICE, UNCHANGED_NOTICE, contentHash,
  compactHeader, dropIgnoredNodes, formatBrowserOutput, presentBrowserCall, rankElementList, toValue,
} from './render.ts'
export type { BrowserToolValue, BrowserValueOptions } from './render.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-browser'

/** The seam, the tool registry, and the prompt registry. */
export const inject = ['browsers', 'tools', 'systemPrompt']

/** Default cooperative tool-call budget for one browser action. */
export const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 60_000

/** Model-facing browser tool configuration. */
export interface Config {
  /** Cap on the element-list characters one call returns. Defaults to 16000. */
  maxStateChars?: number
  /** Include trailing page snapshots; explicit reads always return their snapshot. */
  snapshotMode?: 'full' | 'none'
  /** Return screenshot image blocks, or save evidence without sending image input. */
  imageResponses?: 'allow' | 'omit'
  /** Default minimum severity for browser_console_messages. */
  consoleLevel?: 'error' | 'warning' | 'info' | 'debug'
  /** Absolute directory for private per-call browser artifacts. */
  outputDir?: string
  /** Cooperative tool-call budget (ms) per browser action. Defaults to 60000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxStateChars: z.number().step(1).min(1).default(DEFAULT_MAX_STATE_CHARS),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_BROWSER_TOOL_TIMEOUT_MS),
  snapshotMode: z.union(['full', 'none'] as const).default('full'),
  imageResponses: z.union(['allow', 'omit'] as const).default('allow'),
  consoleLevel: z.union(['error', 'warning', 'info', 'debug'] as const).default('error'),
  outputDir: z.string(),
})

/**
 * Every browser tool answers with the same object: what the action did, then
 * the page it left behind. `action` is absent only for `browser_state`.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'object',
      additionalProperties: false,
      properties: {
        success: { type: 'boolean', required: true },
        message: { type: 'string', required: true },
        selectedText: { type: 'string' },
      },
    },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    header: { type: 'string', required: true },
    content: { type: 'string', required: true },
    footer: { type: 'string', required: true },
    tabs: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['loading', 'complete'] },
          active: { type: 'boolean', required: true },
        },
      },
    },
    tabId: { type: 'integer', required: true },
    activeTabId: { type: 'integer', required: true },
    settled: { type: 'boolean', required: true },
    capturedAt: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    compact: { type: 'boolean', required: true },
    unchanged: { type: 'boolean', required: true },
    mode: { type: 'string', enum: ['full', 'diff'] },
    response: { type: 'string', enum: ['state', 'result', 'none'] },
    filename: { type: 'string' },
    revision: { type: 'integer' },
    baseRevision: { type: 'integer' },
    added: { type: 'array', items: { type: 'string' } },
    changed: { type: 'array', items: { type: 'string' } },
    removed: { type: 'array', items: { type: 'string' } },
    uiChanges: {
      type: 'object',
      additionalProperties: false,
      properties: {
        shown: { type: 'array', items: { type: 'string' }, required: true },
        hidden: { type: 'array', items: { type: 'string' }, required: true },
        expanded: { type: 'array', items: { type: 'string' }, required: true },
        collapsed: { type: 'array', items: { type: 'string' }, required: true },
        changed: { type: 'array', items: { type: 'string' }, required: true },
        focused: { type: 'string' },
      },
    },
  },
} as const

const HISTORY_OUTPUT = {
  schema: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', required: true },
        title: { type: 'string', required: true },
        visitedAt: { type: 'string', required: true },
      },
    },
  } as const,
  render: (_args: unknown, value: BrowserHistorySearchEntry[]) => [{
    type: 'text' as const,
    text: value.length === 0
      ? 'No matching Browser history entries.'
      : value.map(entry => `- ${entry.title || entry.url} — ${entry.url} (${entry.visitedAt})`).join('\n'),
  }],
}

const CDP_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      method: { type: 'string', required: true },
      result: { type: 'object', required: true, additionalProperties: true },
    },
  } as const,
  render: (_args: unknown, value: BrowserCdpCommandResult) => [{
    type: 'text' as const,
    text: `${value.method}\n${JSON.stringify(value.result, undefined, 2)}`,
  }],
}

const CDP_EVENTS_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      events: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sequence: { type: 'integer', required: true },
            method: { type: 'string', required: true },
            params: { type: 'object', required: true, additionalProperties: true },
            receivedAt: { type: 'string', required: true },
          },
        },
      },
      nextSequence: { type: 'integer', required: true },
    },
  } as const,
  render: (_args: unknown, value: BrowserCdpEventPage) => [{
    type: 'text' as const,
    text: value.events.length === 0
      ? `No matching CDP events. Cursor: ${value.nextSequence}`
      : `${value.events.map(event => `[${event.sequence}] ${event.method}\n${JSON.stringify(event.params)}`).join('\n')}\nCursor: ${value.nextSequence}`,
  }],
}

const TABS_OUTPUT = {
  schema: {
    type: 'array',
    items: OUTPUT_SCHEMA.properties.tabs.items,
  } as const,
  render: (_args: unknown, value: BrowserToolValue['tabs']) => [{
    type: 'text' as const,
    text: value.map(tab => `[${tab.id}] ${tab.active ? '(active) ' : ''}${tab.title} — ${tab.url} (${tab.status})`).join('\n'),
  }],
}

/** Durable value retained for a model-facing Browser screenshot result. */
export interface BrowserScreenshotValue extends Pick<BrowserScreenshot, 'tabId' | 'url' | 'title' | 'capturedAt'> {
  filename?: string
  omitImage?: boolean
  image: {
    attachmentId?: string
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
    name?: string
  }
}

function screenshotContent(value: BrowserScreenshotValue): ContentBlock[] {
  return [
    {
      type: 'text',
      text: `${value.filename === undefined ? '' : `Saved screenshot: ${value.filename}\n`}Browser screenshot of tab [${value.tabId}] — ${value.title || value.url}\n${value.url}\n${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes`,
    },
    ...value.image.attachmentId === undefined || value.omitImage === true ? [] : [{ type: 'image' as const, attachment: { ...value.image, attachmentId: AttachmentId(value.image.attachmentId) } }],
  ]
}

const SCREENSHOT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      tabId: { type: 'integer', required: true },
      url: { type: 'string', required: true },
      title: { type: 'string', required: true },
      capturedAt: { type: 'string', required: true },
      filename: { type: 'string' },
      omitImage: { type: 'boolean' },
      image: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string', enum: ['image/png'], required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          name: { type: 'string' },
        },
      },
    },
  } as const,
  render: (_args: unknown, value: BrowserScreenshotValue) => screenshotContent(value),
}

/** The page belongs to the calling agent, so there is nothing to do without one. */
function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('browser tools require an initiating agent')
  return agent
}

/** The origin a URL addresses, or undefined when it is not an absolute URL. */
function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

type TargetTabArgs = { tab_id?: number }

const TAB_ID_PARAMETER = {
  type: 'integer',
  description: 'Controlled tab id from a browser result. Omit to use the tab selected when this call starts.',
} as const

const NAME_PARAMETER = {
  type: 'string',
  description: 'Visible label, accessible name, placeholder, or id from the latest snapshot. Use instead of index when the control is named.',
} as const

const TARGET_PARAMETER = { type: 'string', description: 'Observed Playwright ref (e17) or a unique CSS selector. To reach inside an <iframe> (including cross-origin), chain selectors with " >> ": "iframeSelector >> innerSelector" (repeat to nest further). Use instead of index/name.' } as const
const FILENAME_PARAMETER = { type: 'string', description: 'Plain filename for a private output artifact; returns its absolute path instead of the data.' } as const

const INDEX_OR_NAME_INDEX = {
  type: 'integer',
  description: 'Element index from the latest browser result. Provide this or name.',
} as const

type NamedTarget = { index?: number; name?: string; target?: string }

function namedTarget(args: NamedTarget): NamedTarget {
  const name = args.name?.trim()
  if (args.target !== undefined) {
    if (!args.target.trim() || args.index !== undefined || name !== undefined) throw new Error('provide target alone, or index/name')
    return { target: args.target.trim() }
  }
  if (args.index === undefined && (name === undefined || name.length === 0)) {
    throw new Error('provide index or a non-empty name')
  }
  return {
    ...args.index === undefined ? {} : { index: args.index },
    ...name === undefined || name.length === 0 ? {} : { name },
  }
}

function tabTarget(args: TargetTabArgs): { tabId: number } | Record<string, never> {
  return args.tab_id === undefined ? {} : { tabId: args.tab_id }
}

const FULL_SNAPSHOT_METHODS = new Set<BrowserAction['method']>(['get_browser_state', 'navigate'])

/** Explicit tab targets are isolated by the browser seam and may overlap. */
function targetsTab(args: TargetTabArgs): boolean {
  return args.tab_id !== undefined
}

/* jscpd:ignore-start */
/** Refuse before capture when the current route cannot carry an image result. */
async function assertScreenshotRoute(ctx: Context, exec: ToolExecution): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('cannot take a browser screenshot: the current model route could not be resolved')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot take a browser screenshot: model "${model}" does not declare image input; switch to an image-capable model`)
  }
}
/* jscpd:ignore-end */

/** Register viewport capture with optional durable image delivery. */
function applyScreenshotTool(ctx: Context, timeoutMs: number, outputDir: string, imageResponses: 'allow' | 'omit'): void {
  const register = (name: string): void => { ctx.tools.register(defineTool({
    name,
    description: 'Capture the selected controlled HTTP(S) viewport. A filename saves PNG evidence without image input; otherwise imageResponses selects image delivery. Switch tabs before capture.',
    parameters: { filename: FILENAME_PARAMETER },
    output: SCREENSHOT_OUTPUT,
    timeoutMs,
    async execute(args: { filename?: string }, exec): Promise<BrowserScreenshotValue> {
      if (args.filename !== undefined) validateFilename(args.filename)
      const omitImage = imageResponses === 'omit' || args.filename !== undefined
      const owner = requireAgent(exec.agent)
      const attachments = ctx.get('attachments')
      if (!omitImage && attachments === undefined) throw new Error('cannot take a browser screenshot: no attachment service is mounted; provide filename to save PNG evidence')
      if (!omitImage && attachments !== undefined && !attachments.imageLimits.mediaTypes.includes('image/png')) {
        throw new Error('cannot take a browser screenshot: PNG images are not accepted by this deployment')
      }
      if (!omitImage) await assertScreenshotRoute(ctx, exec)
      exec.signal.throwIfAborted()
      const screenshot = await ctx.browsers.takeScreenshot(owner, { callId: exec.callId, signal: exec.signal })
      exec.signal.throwIfAborted()
      if (omitImage) {
        const filename = await saveBrowserArtifact(outputDir, args.filename ?? 'screenshot.png', Buffer.from(screenshot.data, 'base64'), exec.signal)
        return {
          filename, omitImage: true, tabId: screenshot.tabId, url: screenshot.url,
          title: screenshot.title, capturedAt: screenshot.capturedAt,
          image: { mediaType: 'image/png', bytes: screenshot.bytes, width: screenshot.width, height: screenshot.height },
        }
      }
      if (attachments === undefined) throw new Error('attachment service was unmounted during capture')
      const [image] = await attachments.saveImages([{
        data: Buffer.from(screenshot.data, 'base64'), mediaType: 'image/png', name: `browser-tab-${screenshot.tabId}.png`,
      }])
      if (image === undefined || image.mediaType !== 'image/png') throw new Error('attachment store did not return a PNG image')
      return {
        tabId: screenshot.tabId,
        url: screenshot.url,
        title: screenshot.title,
        capturedAt: screenshot.capturedAt,
        image: {
          attachmentId: image.attachmentId,
          mediaType: image.mediaType,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...image.name === undefined ? {} : { name: image.name },
        },
      }
    },
    presentCall: () => presentBrowserCall('Capture selected browser viewport'),
  })) }
  register('browser_screenshot')
  register('browser_take_screenshot')
}

/** Register the `browser_*` tools and the accessibility-snapshot prompt section. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxStateChars = config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS
  const timeoutMs = config.timeoutMs ?? DEFAULT_BROWSER_TOOL_TIMEOUT_MS
  if (!Number.isSafeInteger(maxStateChars) || maxStateChars < 1) {
    throw new Error('tool-browser: maxStateChars must be a positive integer')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('tool-browser: timeoutMs must be a positive integer')
  }

  const outputDir = config.outputDir ?? join(tmpdir(), 'hydra-browser-output')
  if (!isAbsolute(outputDir)) throw new Error('tool-browser: outputDir must be absolute')
  const snapshotMode = config.snapshotMode ?? 'full'
  const imageResponses = config.imageResponses ?? 'allow'
  const consoleLevel = config.consoleLevel ?? 'error'
  if (!['full', 'none'].includes(snapshotMode) || !['allow', 'omit'].includes(imageResponses)
    || !['error', 'warning', 'info', 'debug'].includes(consoleLevel)) throw new Error('invalid browser output configuration')

  const previousContent = new WeakMap<Agent, Map<number, { url: string; content: string; revision: number; elements: string[] }>>()

  const run = async (exec: ToolExecution, action: BrowserAction, filename?: string): Promise<BrowserToolValue> => {
    if (filename !== undefined) validateFilename(filename)
    const owner = requireAgent(exec.agent)
    const resultOnly = ['find_element', 'console_messages', 'network_requests', 'network_request'].includes(action.method)
    const explicitRead = action.method === 'get_browser_state'
    const omitted = resultOnly || (!explicitRead && snapshotMode === 'none')
    const outcome = await ctx.browsers.perform(owner, action, {
      callId: exec.callId,
      signal: exec.signal,
      ...omitted ? { captureState: false } : {},
    })
    const projected = explicitRead && action.snapshot !== undefined
    const compact = !FULL_SNAPSHOT_METHODS.has(action.method)
    const perTab = previousContent.get(owner) ?? new Map<number, { url: string; content: string; revision: number; elements: string[] }>()
    const previous = omitted || projected ? undefined : perTab.get(outcome.state.tabId)
    const value = toValue(outcome, maxStateChars, {
      compact,
      ...previous === undefined ? {} : { previousContent: previous.content, previousUrl: previous.url },
      ...previous === undefined ? {} : { previousElements: previous.elements, previousRevision: previous.revision },
    })
    if (omitted) {
      value.response = resultOnly ? 'result' : 'none'
      value.content = ''
      value.header = ''
      value.mode = 'full'
      value.truncated = false
    }
    if (filename !== undefined && outcome.action?.success !== false) {
      const data = resultOnly ? outcome.action?.message ?? '' : outcome.state.content
      value.filename = await saveBrowserArtifact(outputDir, filename, data, exec.signal)
      value.response = 'result'
      value.content = ''
      value.header = ''
      if (value.action !== undefined) value.action = { success: value.action.success, message: 'Browser output saved.' }
    }
    if (value.action !== undefined && value.action.message.length > maxStateChars) {
      value.action = { ...value.action, message: `${value.action.message.slice(0, maxStateChars)}\n(Output truncated. Narrow the search or use filename for diagnostic output.)` }
    }
    if (omitted || projected || filename !== undefined || value.truncated || !value.settled) perTab.delete(outcome.state.tabId)
    else perTab.set(outcome.state.tabId, {
      url: outcome.state.url,
      content: rankElementList(dropIgnoredNodes(outcome.state.content)),
      elements: rankElementList(dropIgnoredNodes(outcome.state.content)).split('\n').filter(Boolean),
      revision: value.revision ?? 1,
    })
    for (const tabId of perTab.keys()) {
      if (!outcome.state.tabs.some(tab => tab.id === tabId)) perTab.delete(tabId)
    }
    previousContent.set(owner, perTab)
    return value
  }

  const output = {
    schema: OUTPUT_SCHEMA,
    render: (_args: unknown, value: BrowserToolValue) =>
      [{ type: 'text' as const, text: formatBrowserOutput(value) }],
    presentationMeta: (_args: unknown, value: BrowserToolValue) => value.response === 'result' || value.response === 'none' ? {} : ({
      browser: {
        tabId: value.tabId,
        revision: value.revision ?? 1,
        hash: contentHash([value.content, ...(value.added ?? []), ...(value.changed ?? []), ...(value.removed ?? []),
          ...value.uiChanges === undefined ? [] : [JSON.stringify(value.uiChanges)]].join('\n')),
        mode: value.mode ?? 'full',
      },
    }),
  }

  ctx.systemPrompt.section({
    name: BROWSER_PROMPT_NAME,
    order: BROWSER_PROMPT_ORDER,
    text: BROWSER_PROMPT_TEXT,
  })

  applyScreenshotTool(ctx, timeoutMs, outputDir, imageResponses)

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: 'Close this agent\'s controlled browser and release its tabs. A later browser call opens a fresh controller.',
    parameters: {},
    output: {
      schema: { type: 'boolean' },
      render: (_args: unknown, closed: boolean) => [{ type: 'text' as const, text: closed ? 'Browser closed.' : 'Browser was already closed.' }],
    },
    timeoutMs,
    execute: async (_args, exec) => {
      const owner = requireAgent(exec.agent)
      const closed = await ctx.browsers.close(owner)
      previousContent.delete(owner)
      return closed
    },
    presentCall: () => presentBrowserCall('Close browser'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Open a URL in the embedded browser and return the page as a numbered element list. Starts the browser window if it is not running yet.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL to open.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: async (args: { url: string; tab_id?: number }, exec) => {
      if (args.url.trim().length === 0) throw new Error('url must be a non-empty string')
      if (originOf(args.url) === undefined) throw new Error(`url must be an absolute http(s) URL: ${args.url}`)
      return await run(exec, { method: 'navigate', url: args.url, ...tabTarget(args) })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { url: string }) => presentBrowserCall(`Open ${args.url}`, args.url),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_state',
    description: 'Re-read the current page of the embedded browser, with a bounded readiness wait for SPA or SSO transitions. Explicitly read state after omitted output or when fresh numeric indexes are needed.',
    parameters: { tab_id: TAB_ID_PARAMETER },
    output,
    timeoutMs,
    execute: (args: TargetTabArgs, exec) => run(exec, { method: 'get_browser_state', ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Read browser page'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Read a distilled accessibility tree, optionally scoped to a ref/selector, depth, or output file.',
    parameters: { tab_id: TAB_ID_PARAMETER, target: TARGET_PARAMETER, depth: { type: 'integer', description: 'Maximum tree depth, zero or greater.' }, boxes: { type: 'boolean' }, filename: FILENAME_PARAMETER },
    output,
    timeoutMs,
    execute: (args: TargetTabArgs & { target?: string; depth?: number; boxes?: boolean; filename?: string }, exec) => {
      if (args.depth !== undefined && (!Number.isSafeInteger(args.depth) || args.depth < 0)) throw new Error('depth must be a non-negative integer')
      if (args.target !== undefined && !args.target.trim()) throw new Error('target must be non-empty')
      const { tab_id: _tab, filename, ...snapshot } = args
      return run(exec, { method: 'get_browser_state', snapshot, ...tabTarget(args) }, filename)
    },
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Read accessibility snapshot'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait',
    description: 'Wait up to 1–10 seconds for delayed page data, animation, or navigation, then return a fresh settled page state. Use it instead of repeatedly polling browser_state.',
    parameters: {
      seconds: { type: 'integer', required: true, description: 'Whole seconds to wait, from 1 through 10.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { seconds: number; tab_id?: number }, exec) => {
      if (!Number.isSafeInteger(args.seconds) || args.seconds < 1 || args.seconds > 10) {
        throw new Error('seconds must be an integer from 1 through 10')
      }
      return run(exec, { method: 'wait', seconds: args.seconds, ...tabTarget(args) })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { seconds: number }) => presentBrowserCall(`Wait ${args.seconds}s for browser page`),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait_for',
    description: 'Wait up to ten seconds for text to appear or disappear in the accessibility snapshot, or wait for the specified time.',
    parameters: {
      time: { type: 'number', description: 'Seconds to wait, from 1 through 10.' },
      text: { type: 'string', description: 'Optional text expected in the returned accessibility snapshot.' },
      text_gone: { type: 'string', description: 'Optional text expected to be absent from the returned snapshot.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: async (args: { time?: number; text?: string; text_gone?: string; tab_id?: number }, exec) => {
      const seconds = args.time ?? 10
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10) throw new Error('time must be greater than zero and at most 10 seconds')
      if (args.time === undefined && args.text === undefined && args.text_gone === undefined) throw new Error('provide time, text, or text_gone')
      return run(exec, {
        method: 'wait_for', seconds, ...tabTarget(args),
        ...args.text === undefined ? {} : { text: args.text },
        ...args.text_gone === undefined ? {} : { textGone: args.text_gone },
      })
    },
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Wait for browser state'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: 'List, create, close, or select a controlled browser tab, matching Playwright MCP tab management.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'new', 'close', 'select'] },
      index: { type: 'integer', description: 'Tab id from the latest snapshot for close/select.' },
      url: { type: 'string', description: 'Absolute HTTP(S) URL for a new tab.' },
    },
    output: TABS_OUTPUT,
    timeoutMs,
    execute: async (args: { action: 'list' | 'new' | 'close' | 'select'; index?: number; url?: string }, exec) => {
      if ((args.action === 'close' || args.action === 'select')
        && (!Number.isSafeInteger(args.index) || (args.index ?? 0) < 1)) {
        throw new Error('index must be a positive tab id for close/select')
      }
      if (args.action === 'new' && args.url !== undefined && originOf(args.url) === undefined) {
        throw new Error('url must be an absolute http(s) URL for a new tab')
      }
      const outcome = args.action === 'new'
        ? await run(exec, { method: 'open_new_tab', ...args.url === undefined ? {} : { url: args.url } })
        : args.action === 'close'
          ? await run(exec, { method: 'close_tab', tabId: args.index ?? 0 })
          : args.action === 'select'
            ? await run(exec, { method: 'switch_to_tab', tabId: args.index ?? 0 })
            : await run(exec, { method: 'get_browser_state' })
      previousContent.delete(requireAgent(exec.agent))
      if (outcome.action?.success === false) throw new Error(outcome.action.message)
      return outcome.tabs
    },
    presentCall: () => presentBrowserCall('List browser tabs'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click a control from the latest snapshot by index or by visible name. Indexes are reassigned after every action.',
    parameters: {
      index: INDEX_OR_NAME_INDEX,
      name: NAME_PARAMETER, target: TARGET_PARAMETER,
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index?: number; name?: string; target?: string; tab_id?: number }, exec) =>
      run(exec, { method: 'click_element', ...namedTarget(args), ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index?: number; name?: string; target?: string }) => presentBrowserCall(
      args.index === undefined ? `Click ${args.name ?? args.target}` : `Click [${args.index}]`,
    ),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_hover',
    description: 'Move the native browser pointer onto an observed accessibility ref or named control and return the resulting snapshot.',
    parameters: { index: INDEX_OR_NAME_INDEX, name: NAME_PARAMETER, target: TARGET_PARAMETER, tab_id: TAB_ID_PARAMETER },
    output,
    timeoutMs,
    execute: (args: NamedTarget & TargetTabArgs, exec) => run(exec, { method: 'hover_element', ...namedTarget(args), ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Hover browser control'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_drag',
    description: 'Drag from one observed accessibility ref to another with the native browser pointer held down.',
    parameters: {
      start_index: { type: 'integer', required: true, description: 'Source ref from the latest snapshot.' },
      end_index: { type: 'integer', required: true, description: 'Destination ref from the same snapshot.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { start_index: number; end_index: number } & TargetTabArgs, exec) => {
      if (![args.start_index, args.end_index].every(index => Number.isSafeInteger(index) && index >= 0)) throw new Error('drag refs must be non-negative integers')
      return run(exec, { method: 'drag_element', startIndex: args.start_index, endIndex: args.end_index, ...tabTarget(args) })
    },
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Drag browser control'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_drop',
    description: 'Drop local files or MIME-typed text onto an observed accessibility ref. Local files follow Browser Uploads permissions.',
    parameters: {
      index: { type: 'integer', required: true, description: 'Destination ref from the latest snapshot.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of readable local files.' },
      data: { type: 'object', additionalProperties: true, description: 'MIME type to text, for example text/plain.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index: number; paths?: string[]; data?: Record<string, string> } & TargetTabArgs, exec) => {
      if (!Number.isSafeInteger(args.index) || args.index < 0) throw new Error('index must be a non-negative ref')
      const filePaths = args.paths ?? []
      const data = args.data ?? {}
      if (Object.entries(data).some(([mimeType, value]) => !mimeType.includes('/') || typeof value !== 'string')) throw new Error('data must map MIME types to strings')
      if (filePaths.length === 0 && Object.keys(data).length === 0) throw new Error('provide paths or MIME-typed data')
      return run(exec, { method: 'drop', index: args.index, filePaths, data, ...tabTarget(args) })
    },
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Drop files or data into browser'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_resize',
    description: 'Set the controlled page viewport size in CSS pixels.',
    parameters: {
      width: { type: 'integer', required: true, description: 'Viewport width, from 1 to 8192 pixels.' },
      height: { type: 'integer', required: true, description: 'Viewport height, from 1 to 8192 pixels.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { width: number; height: number } & TargetTabArgs, exec) => {
      if (![args.width, args.height].every(size => Number.isSafeInteger(size) && size >= 1 && size <= 8192)) throw new Error('viewport dimensions must be integers from 1 to 8192')
      return run(exec, { method: 'resize', width: args.width, height: args.height, ...tabTarget(args) })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { width: number; height: number }) => presentBrowserCall(`Resize browser to ${args.width} × ${args.height}`),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_handle_dialog',
    description: 'Accept or dismiss the current JavaScript alert, confirm, or prompt dialog.',
    parameters: {
      accept: { type: 'boolean', required: true, description: 'Accept when true; dismiss when false.' },
      promptText: { type: 'string', description: 'Text to enter in a prompt dialog.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { accept: boolean; promptText?: string } & TargetTabArgs, exec) => run(exec, {
      method: 'handle_dialog', accept: args.accept, ...tabTarget(args),
      ...args.promptText === undefined ? {} : { promptText: args.promptText },
    }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { accept: boolean }) => presentBrowserCall(`${args.accept ? 'Accept' : 'Dismiss'} browser dialog`),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_console_messages',
    description: 'Read retained console messages for this tab. Includes the selected level and more severe levels.',
    parameters: {
      filename: FILENAME_PARAMETER,
      level: { type: 'string', enum: ['error', 'warning', 'info', 'debug'], description: 'Minimum severity; omission uses the deployment consoleLevel.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { filename?: string; level?: 'error' | 'warning' | 'info' | 'debug' } & TargetTabArgs, exec) => run(exec, { method: 'console_messages', level: args.level ?? consoleLevel, ...tabTarget(args) }, args.filename),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Read browser console'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_network_requests',
    description: 'List retained network requests for this tab with stable request indexes for browser_network_request.',
    parameters: { filename: FILENAME_PARAMETER, filter: { type: 'string', description: 'URL regular expression, optionally /pattern/i.' }, static: { type: 'boolean', description: 'Include successful static resources. Defaults to false.' }, tab_id: TAB_ID_PARAMETER },
    output,
    timeoutMs,
    execute: (args: { static?: boolean; filter?: string; filename?: string } & TargetTabArgs, exec) => run(exec, { method: 'network_requests', includeStatic: args.static ?? false, ...args.filter === undefined ? {} : { filter: args.filter }, ...tabTarget(args) }, args.filename),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Read browser network requests'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_network_request',
    description: 'Read headers or body for a retained network request from browser_network_requests. Bodies may expire from Chromium storage.',
    parameters: {
      filename: FILENAME_PARAMETER,
      index: { type: 'integer', required: true, description: 'Request index from browser_network_requests.' },
      part: { type: 'string', enum: ['request-headers', 'request-body', 'response-headers', 'response-body'], description: 'Omit for request and response headers.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { filename?: string; index: number; part?: 'request-headers' | 'request-body' | 'response-headers' | 'response-body' } & TargetTabArgs, exec) => {
      if (!Number.isSafeInteger(args.index) || args.index < 1) throw new Error('index must be a positive request index')
      return run(exec, { method: 'network_request', index: args.index, ...tabTarget(args), ...args.part === undefined ? {} : { part: args.part } }, args.filename)
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index: number }) => presentBrowserCall(`Read browser request ${args.index}`),
  }))

  for (const { name, description, indexDescription, pathDescription } of [
    { name: 'browser_upload_file', description: 'Select one existing readable local file through an indexed HTML file input, including hidden inputs. Use an absolute path and the most recent element list. Uploads permission controls execution and approval for the file and HTTP(S) destination. This selects the file only; submit separately.', indexDescription: 'Element index of the observed HTML file input, including a hidden chooser input.', pathDescription: 'Absolute path of the local file to upload.' },
    { name: 'browser_file_upload', description: 'Choose a local file through an accessibility ref, matching Playwright MCP semantics.', indexDescription: 'Accessibility ref of the file input.', pathDescription: 'Absolute path of the readable local file.' },
  ]) {
    ctx.tools.register(defineTool({
      name,
      description,
      parameters: {
        index: { type: 'integer', required: true, description: indexDescription },
        path: { type: 'string', required: true, description: pathDescription },
        tab_id: TAB_ID_PARAMETER,
      },
      output,
      // ponytail: no cooperative deadline — uploads can require human approval
      // (unbounded wait), and the shared tool-call timeout was firing mid-wait,
      // auto-cancelling the pending approval as if the user had said no. Upgrade
      // to a deadline that pauses across the approval wait if hung uploads matter.
      execute: (args: { index: number; path: string; tab_id?: number }, exec) =>
        run(exec, { method: 'upload_file', index: args.index, filePath: args.path, ...tabTarget(args) }),
      isConcurrencySafe: targetsTab,
      presentCall: (args: { index: number; path: string }) =>
        presentBrowserCall(`Upload file through [${args.index}]`, args.path),
    }))
  }

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an input or textarea by index or visible name. Replaces whatever the field held; it does not append.',
    parameters: {
      index: INDEX_OR_NAME_INDEX,
      name: NAME_PARAMETER, target: TARGET_PARAMETER,
      text: { type: 'string', required: true, description: 'Text to put in the field.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index?: number; name?: string; target?: string; text: string; tab_id?: number }, exec) =>
      run(exec, { method: 'input_text', ...namedTarget(args), text: args.text, ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index?: number; name?: string; target?: string; text: string }) => presentBrowserCall(
      args.index === undefined ? `Type into ${args.name ?? args.target}` : `Type into [${args.index}]`,
      args.text,
    ),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_select_option',
    description: 'Choose a dropdown option by the control\'s index or visible name and the option\'s visible label.',
    parameters: {
      index: INDEX_OR_NAME_INDEX,
      name: NAME_PARAMETER, target: TARGET_PARAMETER,
      text: { type: 'string', required: true, description: 'Visible label of the option to choose.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index?: number; name?: string; target?: string; text: string; tab_id?: number }, exec) =>
      run(exec, { method: 'select_option', ...namedTarget(args), text: args.text, ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index?: number; name?: string; target?: string; text: string }) => presentBrowserCall(
      args.index === undefined ? `Select "${args.text}" in ${args.name ?? args.target}` : `Select "${args.text}" in [${args.index}]`,
    ),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_select_text',
    description: 'Select text across an element by index or visible name, or between explicit coordinates, animating the virtual cursor and updating the native DOM selection.',
    parameters: {
      index: INDEX_OR_NAME_INDEX,
      name: NAME_PARAMETER, target: TARGET_PARAMETER,
      start_x: { type: 'number', description: 'Start X coordinate in CSS pixels.' },
      start_y: { type: 'number', description: 'Start Y coordinate in CSS pixels.' },
      end_x: { type: 'number', description: 'End X coordinate in CSS pixels.' },
      end_y: { type: 'number', description: 'End Y coordinate in CSS pixels.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (
      args: NamedTarget & { start_x?: number; start_y?: number; end_x?: number; end_y?: number; tab_id?: number },
      exec,
    ) => {
      const coordinates = [args.start_x, args.start_y, args.end_x, args.end_y]
      const hasCoords = coordinates.some(value => value !== undefined)
      if (!hasCoords && args.index === undefined && args.target === undefined && (args.name?.trim().length ?? 0) === 0) {
        throw new Error('provide index, a non-empty name, or start and end coordinates')
      }
      if (hasCoords) {
        if (args.start_x === undefined || args.start_y === undefined || args.end_x === undefined || args.end_y === undefined
          || !coordinates.every(value => value !== undefined && Number.isFinite(value) && value >= 0)) {
          throw new Error('provide all four finite, non-negative coordinates')
        }
        return run(exec, { method: 'select_text', startX: args.start_x, startY: args.start_y, endX: args.end_x, endY: args.end_y, ...tabTarget(args) })
      }
      return run(exec, { method: 'select_text', ...namedTarget(args), ...tabTarget(args) })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index?: number; name?: string; target?: string }) => presentBrowserCall(
      args.index !== undefined ? `Select text in [${args.index}]` : args.name !== undefined ? `Select text in ${args.name}` : args.target !== undefined ? `Select text in ${args.target}` : 'Select text across range',
    ),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the page, or a scrollable element, to bring more of it into the element list. Only the visible viewport is ever listed.',
    parameters: {
      down: { type: 'boolean', required: true, description: 'True scrolls towards the end of the page, false towards the start.' },
      num_pages: { type: 'number', description: 'Viewport heights to scroll. Defaults to 1, and is ignored when pixels is given.' },
      pixels: { type: 'number', description: 'Exact distance to scroll, instead of whole viewports.' },
      index: { type: 'integer', description: 'Scroll this element instead of the page.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { down: boolean; num_pages?: number; pixels?: number; index?: number; tab_id?: number }, exec) =>
      run(exec, {
        method: 'scroll',
        down: args.down,
        numPages: args.num_pages ?? 1,
        ...args.pixels === undefined ? {} : { pixels: args.pixels },
        ...args.index === undefined ? {} : { index: args.index },
        ...tabTarget(args),
      }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { down: boolean }) => presentBrowserCall(`Scroll ${args.down ? 'down' : 'up'}`),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll_horizontally',
    description: 'Scroll the page, or one scrollable element, horizontally and return the newly visible indexed controls.',
    parameters: {
      right: { type: 'boolean', required: true, description: 'True scrolls right, false scrolls left.' },
      pixels: { type: 'number', required: true, description: 'Positive horizontal distance in pixels.' },
      index: { type: 'integer', description: 'Scroll this element instead of the page.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { right: boolean; pixels: number; index?: number; tab_id?: number }, exec) => {
      if (!Number.isFinite(args.pixels) || args.pixels <= 0) throw new Error('pixels must be a positive number')
      return run(exec, {
        method: 'scroll_horizontally',
        right: args.right,
        pixels: args.pixels,
        ...args.index === undefined ? {} : { index: args.index },
        ...tabTarget(args),
      })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { right: boolean }) => presentBrowserCall(`Scroll ${args.right ? 'right' : 'left'}`),
  }))

  for (const { name, description, keyDescription } of [
    { name: 'browser_press', description: 'Send one key to whatever the page has focused — Enter to submit a form, Tab to move on, Escape to dismiss.', keyDescription: 'Key name, such as Enter, Tab, Escape, or Backspace.' },
    { name: 'browser_press_key', description: 'Press one keyboard key using the focused page control, matching Playwright MCP semantics.', keyDescription: 'Key name such as Enter, Tab, Escape, or Backspace.' },
  ]) {
    ctx.tools.register(defineTool({
      name,
      description,
      parameters: {
        key: { type: 'string', required: true, description: keyDescription },
        tab_id: TAB_ID_PARAMETER,
      },
      output,
      timeoutMs,
      execute: (args: { key: string; tab_id?: number }, exec) => {
        if (args.key.trim().length === 0) throw new Error('key must be a non-empty string')
        return run(exec, { method: 'press', key: args.key, ...tabTarget(args) })
      },
      isConcurrencySafe: targetsTab,
      presentCall: (args: { key: string }) => presentBrowserCall(`Press ${args.key}`),
    }))
  }

  ctx.tools.register(defineTool({
    name: 'browser_back',
    description: 'Go back to the previous page in this window. Reports a failure when there is nothing to go back to.',
    parameters: { tab_id: TAB_ID_PARAMETER },
    output,
    timeoutMs,
    execute: (args: TargetTabArgs, exec) => run(exec, { method: 'back', ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Go back'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate_back',
    description: 'Navigate back one page and return a fresh accessibility snapshot.',
    parameters: { tab_id: TAB_ID_PARAMETER },
    output,
    timeoutMs,
    execute: (args: TargetTabArgs, exec) => run(exec, { method: 'back', ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Navigate back'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_forward',
    description: 'Go forward to the next page in this window. Reports a failure when there is nothing to go forward to.',
    parameters: { tab_id: TAB_ID_PARAMETER },
    output,
    timeoutMs,
    execute: (args: TargetTabArgs, exec) => run(exec, { method: 'forward', ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Go forward'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_find',
    description: 'Search the accessibility tree for text or regex. Returns matching snippets with observed refs and ancestor context, without a trailing page snapshot.',
    parameters: {
      text: { type: 'string', description: 'Case-insensitive text to find; provide text or regex.' },
      regex: { type: 'string', description: 'Regular expression, optionally /pattern/i.' },
      query: { type: 'string', description: 'Alias for text.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { text?: string; query?: string; regex?: string; tab_id?: number }, exec) => {
      if ([args.text, args.query, args.regex].filter(value => value !== undefined).length !== 1) throw new Error('provide exactly one of text, regex, or query')
      const text = args.text ?? args.query
      if (text !== undefined && !text.trim()) throw new Error('query must be a non-empty string')
      if (args.regex !== undefined) {
        const literal = /^\/(.*)\/([imsu]*)$/su.exec(args.regex)
        if (!args.regex.trim()) throw new Error('regex must be non-empty')
        new RegExp(literal?.[1] ?? args.regex, literal?.[2])
      }
      if (args.regex !== undefined) return run(exec, { method: 'find_element', regex: args.regex, ...tabTarget(args) })
      if (text === undefined) throw new Error('provide exactly one of text, regex, or query')
      return run(exec, { method: 'find_element', ...args.query === undefined ? { text } : { query: args.query }, ...tabTarget(args) })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { text?: string; query?: string; regex?: string }) => presentBrowserCall('Find browser control', args.text ?? args.regex ?? args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_fill',
    description: 'Type several named or indexed fields in one call. Each field is re-resolved after the previous one so autocomplete cannot steal later indexes.',
    parameters: {
      fields: {
        type: 'array',
        required: true,
        description: 'Fields to fill, each identified by index or name.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: INDEX_OR_NAME_INDEX,
            name: NAME_PARAMETER, target: TARGET_PARAMETER,
            text: { type: 'string', required: true, description: 'Text to put in the field.' },
          },
        },
      },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { fields: Array<NamedTarget & { text: string }>; tab_id?: number }, exec) => {
      if (!Array.isArray(args.fields) || args.fields.length === 0) {
        throw new Error('fields must be a non-empty array')
      }
      return run(exec, {
        method: 'fill_fields',
        fields: args.fields.map(field => ({ ...namedTarget(field), text: field.text })),
        ...tabTarget(args),
      })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { fields: unknown[] }) => presentBrowserCall(`Fill ${args.fields.length} browser fields`),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_fill_form',
    description: 'Fill multiple form controls by accessibility ref or accessible name, matching Playwright MCP semantics.',
    parameters: {
      fields: {
        type: 'array',
        required: true,
        description: 'Fields to fill, each identified by index or accessible name.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: INDEX_OR_NAME_INDEX,
            name: NAME_PARAMETER, target: TARGET_PARAMETER,
            text: { type: 'string', required: true, description: 'Value to put in the field.' },
          },
        },
      },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    /* jscpd:ignore-start */
    execute: (args: { fields: Array<NamedTarget & { text: string }>; tab_id?: number }, exec) => {
      if (!Array.isArray(args.fields) || args.fields.length === 0) throw new Error('fields must be a non-empty array')
      return run(exec, {
        method: 'fill_fields',
        fields: args.fields.map(field => ({ ...namedTarget(field), text: field.text })),
        ...tabTarget(args),
      })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { fields: unknown[] }) => presentBrowserCall(`Fill ${args.fields.length} browser fields`),
  }))
  /* jscpd:ignore-end */

  ctx.tools.register(defineTool({
    name: 'browser_history_search',
    description: 'Search the built-in Browser profile history after applying the user\'s sensitive-history access policy. Returns at most 20 matching pages; use browser_navigate to reopen one.',
    parameters: {
      query: { type: 'string', required: true, description: 'Case-insensitive title or URL text, from 1 to 256 characters.' },
    },
    output: HISTORY_OUTPUT,
    // ponytail: no cooperative deadline — this can require human approval
    // (unbounded wait); see the upload registration above for why.
    execute: async (args: { query: string }, exec) => {
      const query = args.query.trim()
      if (query.length === 0 || query.length > 256) throw new Error('query must contain 1 to 256 characters')
      return await ctx.browsers.searchHistory(requireAgent(exec.agent), query, {
        callId: exec.callId,
        signal: exec.signal,
      })
    },
    presentCall: (args: { query: string }) => presentBrowserCall('Search Browser history', args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_open_tab',
    description: 'Open and select a new controlled browser tab, optionally at an absolute HTTP(S) URL. Every browser result lists all tab ids.',
    parameters: {
      url: { type: 'string', description: 'Optional absolute HTTP(S) URL; omitted opens a blank tab.' },
    },
    output,
    timeoutMs,
    execute: (args: { url?: string }, exec) => {
      if (args.url !== undefined && (args.url.trim().length === 0 || originOf(args.url) === undefined)) {
        throw new Error(`url must be an absolute http(s) URL: ${args.url}`)
      }
      return run(exec, { method: 'open_new_tab', ...args.url === undefined ? {} : { url: args.url } })
    },
    presentCall: (args: { url?: string }) => presentBrowserCall(
      args.url === undefined ? 'Open browser tab' : `Open tab ${args.url}`,
      args.url,
    ),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_switch_tab',
    description: 'Select a controlled tab by an id from the latest browser result, then return its fresh page state.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'Tab id from the latest browser result.' },
    },
    output,
    timeoutMs,
    execute: (args: { tab_id: number }, exec) => run(exec, { method: 'switch_to_tab', tabId: args.tab_id }),
    presentCall: (args: { tab_id: number }) => presentBrowserCall(`Switch to tab [${args.tab_id}]`),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close_tab',
    description: 'Close a controlled tab by id. The agent cannot close the last tab or the browser window.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'Tab id from the latest browser result.' },
    },
    output,
    timeoutMs,
    execute: (args: { tab_id: number }, exec) => run(exec, { method: 'close_tab', tabId: args.tab_id }),
    presentCall: (args: { tab_id: number }) => presentBrowserCall(`Close tab [${args.tab_id}]`),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_page_agent_run',
    description: 'Start the vendored PageAgent ReAct engine only when the user explicitly asks for that upstream engine. Ordinary browsing uses the indexed and named Hydra tools instead. It uses this Hydra agent\'s selected provider and model through a private host bridge; it never receives an API key or renders UI in the webpage.',
    parameters: {
      task: { type: 'string', required: true, description: 'Concrete browser task for PageAgent to perform.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { task: string; tab_id?: number }, exec) => {
      if (args.task.trim().length === 0) throw new Error('task must be a non-empty string')
      return run(exec, { method: 'page_agent_run', task: args.task, ...tabTarget(args) })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { task: string }) => presentBrowserCall('Run upstream PageAgent', args.task),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_page_agent_status',
    description: 'Read the status and latest result of the upstream PageAgent task running in the controlled page.',
    parameters: { tab_id: TAB_ID_PARAMETER },
    output,
    timeoutMs,
    execute: (args: TargetTabArgs, exec) => run(exec, { method: 'page_agent_status', ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Read upstream PageAgent status'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_page_agent_stop',
    description: 'Stop the active upstream PageAgent task in the controlled page.',
    parameters: { tab_id: TAB_ID_PARAMETER },
    output,
    timeoutMs,
    execute: (args: TargetTabArgs, exec) => run(exec, { method: 'page_agent_stop', ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Stop upstream PageAgent'),
  }))

  if (ctx.browsers.experimentalScriptExecution) {
    ctx.tools.register(defineTool({
      name: 'browser_execute_javascript',
      description: 'EXPERIMENTAL: execute JavaScript in PageController\'s isolated document world, then return fresh state. This can mutate the page and cannot access page-world JavaScript globals.',
      parameters: {
        script: { type: 'string', required: true, description: 'JavaScript function body to execute in the isolated document world.' },
        tab_id: TAB_ID_PARAMETER,
      },
      output,
      timeoutMs,
      execute: (args: { script: string; tab_id?: number }, exec) => {
        if (args.script.trim().length === 0) throw new Error('script must be a non-empty string')
        return run(exec, { method: 'execute_javascript', script: args.script, ...tabTarget(args) })
      },
      isConcurrencySafe: targetsTab,
      presentCall: (args: { script: string }) => presentBrowserCall('Execute browser JavaScript', args.script),
    }))
    ctx.tools.register(defineTool({
      name: 'browser_evaluate',
      description: 'EXPERIMENTAL: evaluate JavaScript in the isolated browser document world, matching Playwright MCP naming.',
      parameters: {
        script: { type: 'string', required: true, description: 'JavaScript function body to evaluate.' },
        tab_id: TAB_ID_PARAMETER,
      },
      output,
      timeoutMs,
      /* jscpd:ignore-start */
      execute: (args: { script: string; tab_id?: number }, exec) => {
        if (args.script.trim().length === 0) throw new Error('script must be a non-empty string')
        return run(exec, { method: 'execute_javascript', script: args.script, ...tabTarget(args) })
      },
      isConcurrencySafe: targetsTab,
      presentCall: (args: { script: string }) => presentBrowserCall('Evaluate browser JavaScript', args.script),
    }))
    /* jscpd:ignore-end */
  }


  let disposeCdp: (() => void) | undefined
  const syncCdpTool = (enabled = ctx.browsers.fullCdpAccess): void => {
    if (!enabled) {
      disposeCdp?.()
      disposeCdp = undefined
      return
    }
    if (disposeCdp !== undefined) return
    const disposeCommand = ctx.tools.register(defineTool({
      name: 'browser_cdp_command',
      description: 'Elevated risk: send one raw Chrome DevTools Protocol command to the selected controlled Browser tab. Every command requires explicit approval; cross-target Browser/Target domains are unavailable.',
      parameters: {
        method: { type: 'string', required: true, description: 'CDP method in Domain.command form, such as Runtime.evaluate.' },
        params: { type: 'object', additionalProperties: true, description: 'Optional JSON object of CDP command parameters.' },
        tab_id: TAB_ID_PARAMETER,
      },
      output: CDP_OUTPUT,
      // ponytail: no cooperative deadline — every call requires human approval
      // (unbounded wait); see the upload registration above for why.
      execute: async (args: { method: string; params?: Record<string, unknown>; tab_id?: number }, exec) =>
        await ctx.browsers.sendCdpCommand(
          requireAgent(exec.agent),
          args.method,
          args.params ?? {},
          args.tab_id,
          { callId: exec.callId, signal: exec.signal },
        ),
      isConcurrencySafe: targetsTab,
      presentCall: (args: { method: string }) => presentBrowserCall(`Run CDP ${args.method}`),
    }))
    const disposeEvents = ctx.tools.register(defineTool({
      name: 'browser_cdp_read_events',
      description: 'Elevated risk: read a bounded cursor page of Chrome DevTools Protocol events captured from the selected controlled Browser tab. Every read requires explicit approval.',
      parameters: {
        after_sequence: { type: 'integer', description: 'Return events after this sequence. Defaults to 0.' },
        limit: { type: 'integer', description: 'Maximum events, from 1 to 100. Defaults to 100.' },
        method: { type: 'string', description: 'Optional exact CDP event method, such as Network.responseReceived.' },
        tab_id: TAB_ID_PARAMETER,
      },
      output: CDP_EVENTS_OUTPUT,
      // ponytail: no cooperative deadline — every call requires human approval
      // (unbounded wait); see the upload registration above for why.
      execute: async (args: {
        after_sequence?: number
        limit?: number
        method?: string
        tab_id?: number
      }, exec) => await ctx.browsers.readCdpEvents(requireAgent(exec.agent), {
        ...args.after_sequence === undefined ? {} : { afterSequence: args.after_sequence },
        ...args.limit === undefined ? {} : { limit: args.limit },
        ...args.method === undefined ? {} : { method: args.method },
        ...args.tab_id === undefined ? {} : { tabId: args.tab_id },
      }, { callId: exec.callId, signal: exec.signal }),
      isConcurrencySafe: targetsTab,
      presentCall: () => presentBrowserCall('Read Browser CDP events'),
    }))
    disposeCdp = () => {
      disposeEvents()
      disposeCommand()
    }
  }
  syncCdpTool()
  ctx.on('browser/full-cdp-access', syncCdpTool)
}
