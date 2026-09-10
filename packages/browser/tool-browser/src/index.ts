/**
 * Model-facing `browser_*` tools over the embedded-browser seam (`ctx.browsers`).
 * This package owns the schemas, the DOM-format prompt section, bounding, and
 * presentation; the seam owns the window and the page.
 * @module @hydra/harness-tool-browser
 */

import { Buffer } from 'node:buffer'
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
  DEFAULT_MAX_STATE_CHARS, dropIgnoredNodes, formatBrowserOutput, presentBrowserCall, rankElementList, toValue,
} from './render.ts'
import type { BrowserToolValue } from './render.ts'

export { BROWSER_PROMPT_NAME, BROWSER_PROMPT_ORDER, BROWSER_PROMPT_TEXT } from './prompt.ts'
export {
  COMPACT_NOTICE, DEFAULT_COMPACT_STATE_CHARS, DEFAULT_MAX_STATE_CHARS, TRUNCATION_NOTICE, UNCHANGED_NOTICE,
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
  /** Cooperative tool-call budget (ms) per browser action. Defaults to 60000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxStateChars: z.number().step(1).min(1).default(DEFAULT_MAX_STATE_CHARS),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_BROWSER_TOOL_TIMEOUT_MS),
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

/** Durable value retained for a model-facing Browser screenshot result. */
export interface BrowserScreenshotValue extends Pick<BrowserScreenshot, 'tabId' | 'url' | 'title' | 'capturedAt'> {
  image: {
    attachmentId: string
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
      text: `Browser screenshot of tab [${value.tabId}] — ${value.title || value.url}\n${value.url}\n${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes`,
    },
    { type: 'image', attachment: { ...value.image, attachmentId: AttachmentId(value.image.attachmentId) } },
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
      image: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          attachmentId: { type: 'string', required: true },
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

const INDEX_OR_NAME_INDEX = {
  type: 'integer',
  description: 'Element index from the latest browser result. Provide this or name.',
} as const

type NamedTarget = { index?: number; name?: string }

function namedTarget(args: NamedTarget): NamedTarget {
  const name = args.name?.trim()
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

/** Register the attachment-backed visual read while a durable store is mounted. */
function applyScreenshotTool(ctx: Context, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture the visible viewport of the currently selected controlled HTTP(S) page and return it as an image. It cannot target a background tab or browser chrome.',
    parameters: {},
    output: SCREENSHOT_OUTPUT,
    timeoutMs,
    async execute(_args, exec): Promise<BrowserScreenshotValue> {
      const owner = requireAgent(exec.agent)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('cannot take a browser screenshot: no attachment service is mounted')
      if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
        throw new Error('cannot take a browser screenshot: PNG images are not accepted by this deployment')
      }
      await assertScreenshotRoute(ctx, exec)
      exec.signal.throwIfAborted()
      const screenshot = await ctx.browsers.takeScreenshot(owner)
      exec.signal.throwIfAborted()
      const [image] = await attachments.saveImages([{
        data: Buffer.from(screenshot.data, 'base64'),
        mediaType: 'image/png',
        name: `browser-tab-${screenshot.tabId}.png`,
      }])
      if (image === undefined) throw new Error('cannot take a browser screenshot: attachment store returned no image')
      if (image.mediaType !== 'image/png') {
        throw new Error('cannot take a browser screenshot: attachment store returned a non-PNG image')
      }
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
  }))
}

/** Register the `browser_*` tools and the DOM-format prompt section. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxStateChars = config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS
  const timeoutMs = config.timeoutMs ?? DEFAULT_BROWSER_TOOL_TIMEOUT_MS
  if (!Number.isSafeInteger(maxStateChars) || maxStateChars < 1) {
    throw new Error('tool-browser: maxStateChars must be a positive integer')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('tool-browser: timeoutMs must be a positive integer')
  }

  const previousContent = new WeakMap<Agent, Map<number, { url: string; content: string }>>()

  const run = async (exec: ToolExecution, action: BrowserAction): Promise<BrowserToolValue> => {
    const owner = requireAgent(exec.agent)
    const outcome = await ctx.browsers.perform(owner, action, {
      callId: exec.callId,
      signal: exec.signal,
    })
    const compact = !FULL_SNAPSHOT_METHODS.has(action.method)
    const perTab = previousContent.get(owner) ?? new Map<number, { url: string; content: string }>()
    const previous = compact ? perTab.get(outcome.state.tabId) : undefined
    const value = toValue(outcome, maxStateChars, {
      compact,
      ...previous === undefined ? {} : { previousContent: previous.content, previousUrl: previous.url },
    })
    perTab.set(outcome.state.tabId, {
      url: outcome.state.url,
      content: rankElementList(dropIgnoredNodes(outcome.state.content)),
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
  }

  ctx.systemPrompt.section({
    name: BROWSER_PROMPT_NAME,
    order: BROWSER_PROMPT_ORDER,
    text: BROWSER_PROMPT_TEXT,
  })

  ctx.inject(['attachments'], (screenshotCtx) => {
    applyScreenshotTool(screenshotCtx, timeoutMs)
  })

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
    description: 'Re-read the current page of the embedded browser, with a bounded readiness wait for SPA or SSO transitions. Every other browser tool already returns fresh state.',
    parameters: { tab_id: TAB_ID_PARAMETER },
    output,
    timeoutMs,
    execute: (args: TargetTabArgs, exec) => run(exec, { method: 'get_browser_state', ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: () => presentBrowserCall('Read browser page'),
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
    name: 'browser_click',
    description: 'Click a control from the latest snapshot by index or by visible name. Indexes are reassigned after every action.',
    parameters: {
      index: INDEX_OR_NAME_INDEX,
      name: NAME_PARAMETER,
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index?: number; name?: string; tab_id?: number }, exec) =>
      run(exec, { method: 'click_element', ...namedTarget(args), ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index?: number; name?: string }) => presentBrowserCall(
      args.index === undefined ? `Click ${args.name}` : `Click [${args.index}]`,
    ),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_upload_file',
    description: 'Upload one existing readable local file through the HTML file input at the given index of the most recent element list. The user must have written the exact absolute path in the current turn, and the current page must use http(s). This selects the file only; submit separately.',
    parameters: {
      index: { type: 'integer', required: true, description: 'Element index of the observed HTML file input.' },
      path: { type: 'string', required: true, description: 'Absolute path of the local test artifact to upload.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index: number; path: string; tab_id?: number }, exec) =>
      run(exec, { method: 'upload_file', index: args.index, filePath: args.path, ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index: number; path: string }) =>
      presentBrowserCall(`Upload file through [${args.index}]`, args.path),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an input or textarea by index or visible name. Replaces whatever the field held; it does not append.',
    parameters: {
      index: INDEX_OR_NAME_INDEX,
      name: NAME_PARAMETER,
      text: { type: 'string', required: true, description: 'Text to put in the field.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index?: number; name?: string; text: string; tab_id?: number }, exec) =>
      run(exec, { method: 'input_text', ...namedTarget(args), text: args.text, ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index?: number; name?: string; text: string }) => presentBrowserCall(
      args.index === undefined ? `Type into ${args.name}` : `Type into [${args.index}]`,
      args.text,
    ),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_select_option',
    description: 'Choose a dropdown option by the control\'s index or visible name and the option\'s visible label.',
    parameters: {
      index: INDEX_OR_NAME_INDEX,
      name: NAME_PARAMETER,
      text: { type: 'string', required: true, description: 'Visible label of the option to choose.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index?: number; name?: string; text: string; tab_id?: number }, exec) =>
      run(exec, { method: 'select_option', ...namedTarget(args), text: args.text, ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index?: number; name?: string; text: string }) => presentBrowserCall(
      args.index === undefined ? `Select "${args.text}" in ${args.name}` : `Select "${args.text}" in [${args.index}]`,
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

  ctx.tools.register(defineTool({
    name: 'browser_press',
    description: 'Send one key to whatever the page has focused — Enter to submit a form, Tab to move on, Escape to dismiss.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key name, such as Enter, Tab, Escape, or Backspace.' },
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
    description: 'Find controls matching a visible name, label, placeholder, or id in the current snapshot. Scrolls once if needed and returns matching indexes for the next action.',
    parameters: {
      query: { type: 'string', required: true, description: 'Visible label, accessible name, placeholder, or id to search for.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { query: string; tab_id?: number }, exec) => {
      if (args.query.trim().length === 0) throw new Error('query must be a non-empty string')
      return run(exec, { method: 'find_element', query: args.query.trim(), ...tabTarget(args) })
    },
    isConcurrencySafe: targetsTab,
    presentCall: (args: { query: string }) => presentBrowserCall('Find browser control', args.query),
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
            name: NAME_PARAMETER,
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
    name: 'browser_history_search',
    description: 'Search the built-in Browser profile history after applying the user\'s sensitive-history access policy. Returns at most 20 matching pages; use browser_navigate to reopen one.',
    parameters: {
      query: { type: 'string', required: true, description: 'Case-insensitive title or URL text, from 1 to 256 characters.' },
    },
    output: HISTORY_OUTPUT,
    timeoutMs,
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
      timeoutMs,
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
      timeoutMs,
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
