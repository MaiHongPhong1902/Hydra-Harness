/**
 * Model-facing `browser_*` tools over the embedded-browser seam (`ctx.browsers`).
 * This package owns the schemas, the DOM-format prompt section, bounding, and
 * presentation; the seam owns the window and the page.
 * @module @bosch/bh-tool-browser
 */

import type { Context } from '@bosch/cordis'
import z from '@bosch/schemastery'
import type { Agent } from '@bosch/bh-agent'
import type { BrowserAction } from '@bosch/bh-browser-electron'
import type {} from '@bosch/bh-browser-electron'
import { defineTool } from '@bosch/bh-tools'
import type { ToolExecution } from '@bosch/bh-tools'
import type {} from '@bosch/bh-system-prompt'
import { BROWSER_PROMPT_NAME, BROWSER_PROMPT_ORDER, BROWSER_PROMPT_TEXT } from './prompt.ts'
import { DEFAULT_MAX_STATE_CHARS, formatBrowserOutput, presentBrowserCall, toValue } from './render.ts'
import type { BrowserToolValue } from './render.ts'

export { BROWSER_PROMPT_NAME, BROWSER_PROMPT_ORDER, BROWSER_PROMPT_TEXT } from './prompt.ts'
export { DEFAULT_MAX_STATE_CHARS, TRUNCATION_NOTICE, formatBrowserOutput, presentBrowserCall, toValue } from './render.ts'
export type { BrowserToolValue } from './render.ts'

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
  },
} as const

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

function tabTarget(args: TargetTabArgs): { tabId: number } | Record<string, never> {
  return args.tab_id === undefined ? {} : { tabId: args.tab_id }
}

/** Explicit tab targets are isolated by the browser seam and may overlap. */
function targetsTab(args: TargetTabArgs): boolean {
  return args.tab_id !== undefined
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

  const run = async (exec: ToolExecution, action: BrowserAction): Promise<BrowserToolValue> =>
    toValue(await ctx.browsers.perform(requireAgent(exec.agent), action), maxStateChars)

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
    description: 'Click the element at the given index of the most recent element list. Indexes are reassigned after every action, so use one from the latest result.',
    parameters: {
      index: { type: 'integer', required: true, description: 'Element index from the latest browser result.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index: number; tab_id?: number }, exec) =>
      run(exec, { method: 'click_element', index: args.index, ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index: number }) => presentBrowserCall(`Click [${args.index}]`),
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
    description: 'Type text into the input or textarea at the given index. Replaces whatever the field held; it does not append.',
    parameters: {
      index: { type: 'integer', required: true, description: 'Element index from the latest browser result.' },
      text: { type: 'string', required: true, description: 'Text to put in the field.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index: number; text: string; tab_id?: number }, exec) =>
      run(exec, { method: 'input_text', index: args.index, text: args.text, ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index: number; text: string }) => presentBrowserCall(`Type into [${args.index}]`, args.text),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_select_option',
    description: 'Choose an option of the dropdown at the given index by its visible label.',
    parameters: {
      index: { type: 'integer', required: true, description: 'Element index of the dropdown.' },
      text: { type: 'string', required: true, description: 'Visible label of the option to choose.' },
      tab_id: TAB_ID_PARAMETER,
    },
    output,
    timeoutMs,
    execute: (args: { index: number; text: string; tab_id?: number }, exec) =>
      run(exec, { method: 'select_option', index: args.index, text: args.text, ...tabTarget(args) }),
    isConcurrencySafe: targetsTab,
    presentCall: (args: { index: number; text: string }) => presentBrowserCall(`Select "${args.text}" in [${args.index}]`),
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
    description: 'Start the real upstream PageAgent ReAct engine under BH control. It uses this BH agent’s selected provider and model through a private host bridge; it never receives an API key or renders UI in the webpage. Poll browser_page_agent_status or stop it explicitly.',
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
}
