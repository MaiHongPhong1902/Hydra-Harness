import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@bosch/cordis'
import { AttachmentId, AttachmentStore } from '@bosch/bh-attachment'
import type {
  ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment,
} from '@bosch/bh-attachment'
import { CallId, createUserMessage } from '@bosch/bh-llm'
import type { ContentBlock } from '@bosch/bh-llm'
import { Session, SessionId } from '@bosch/bh-session'
import AgentRegistry, { Inbox } from '@bosch/bh-agent'
import type { Agent } from '@bosch/bh-agent'
import SystemPrompt from '@bosch/bh-system-prompt'
import ToolRuntime from '@bosch/bh-tools'
import { SettingsProvider } from '@bosch/bh-settings'
import type { SettingsNamespace } from '@bosch/bh-settings'
import BrowserSessionService, { BROWSER_SETTINGS_NAMESPACE } from '@bosch/bh-browser-electron'
import type { BrowserChildProcess } from '@bosch/bh-browser-electron'
import * as ToolBrowser from '@bosch/bh-tool-browser'
import { BROWSER_PROMPT_NAME, BROWSER_PROMPT_TEXT } from '@bosch/bh-tool-browser'

function cdpEventPage(args: Record<string, unknown>) {
  const retained = [
    {
      sequence: 11,
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log' },
      receivedAt: '2026-08-26T00:00:01.000Z',
    },
    {
      sequence: 12,
      method: 'Network.responseReceived',
      params: { requestId: 'shop-request' },
      receivedAt: '2026-08-26T00:00:02.000Z',
    },
  ]
  const afterSequence = typeof args.afterSequence === 'number' ? args.afterSequence : 0
  const limit = typeof args.limit === 'number' ? args.limit : 100
  const events = []
  let nextSequence = afterSequence
  for (const event of retained) {
    if (event.sequence <= afterSequence) continue
    nextSequence = event.sequence
    if (args.method !== undefined && event.method !== args.method) continue
    events.push(event)
    if (events.length === limit) return { events, nextSequence }
  }
  return { events, nextSequence: Math.max(nextSequence, 12) }
}

/**
 * The Electron child the seam would have spawned, answering the way the real
 * main process does: `{success, message}` for actions, a page for a state read.
 */
class ScriptedChild extends EventEmitter implements BrowserChildProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: { method: string; args: Record<string, unknown> }[] = []

  constructor(private readonly content: string) {
    super()
    createInterface({ input: this.stdin }).on('line', (line: string) => {
      const { id, method, args } = JSON.parse(line) as { id: number; method: string; args: Record<string, unknown> }
      this.requests.push({ method, args })
      const result = method === 'get_browser_state'
        ? {
          url: 'https://shop.test/order',
          title: 'Order',
          header: 'Current Page: [Order](https://shop.test/order)',
          content: this.content,
          footer: '[End of page]',
          tabs: [{ id: 1, url: 'https://shop.test/order', title: 'Order', status: 'complete', active: true }],
          tabId: typeof args.tabId === 'number' ? args.tabId : 1,
          activeTabId: 1,
          settled: true,
          capturedAt: '2026-08-24T00:00:00.000Z',
        }
        : method === 'browser_screenshot'
          ? {
            mediaType: 'image/png',
            data: PNG_1X1.toString('base64'),
            bytes: PNG_1X1.length,
            width: 1,
            height: 1,
            tabId: 1,
            url: 'https://shop.test/order',
            title: 'Order',
            capturedAt: '2026-08-27T00:00:00.000Z',
          }
          : method === 'get_upload_target'
            ? { origin: 'https://shop.test', tabId: typeof args.tabId === 'number' ? args.tabId : 1 }
            : method === 'search_browser_history'
              ? [{ url: 'https://shop.test/history', title: 'Saved order', visitedAt: '2026-08-26T00:00:00.000Z' }]
              : method === 'get_cdp_target'
                ? { origin: 'https://shop.test', tabId: typeof args.tabId === 'number' ? args.tabId : 1 }
                : method === 'cdp_command'
                  ? { echo: args.params }
                  : method === 'cdp_read_events'
                    ? cdpEventPage(args)
                    : { success: true, message: `did ${method}` }
      this.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`)
    })
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`))
  }

  kill(): void {
    this.emit('exit')
  }
}

const PAGE = '[0]<input id=who/>\n[1]<button id=submit>Order</button>'
const UPLOAD_FIXTURE = fileURLToPath(new URL('../../browser-electron/tests/fixtures/form.html', import.meta.url))
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

class TestAttachmentStore extends AttachmentStore {
  readonly saved: SaveImageAttachment[] = []
  readonly imageLimits: ImageAttachmentLimits = Object.freeze({
    maxImageBytes: 3_500_000,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 3_500_000,
    maxImagePixels: 4_000_000,
    maxImageDimension: 2_000,
    mediaTypes: Object.freeze(['image/png'] as const),
  })

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return Promise.resolve({
      attachmentId: AttachmentId('sha256:browser-screenshot'),
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    })
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('unreachable in tool-browser tests')
  }
}

class MemorySettings extends SettingsProvider {
  private stored: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.stored)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored = { ...this.stored, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function harness(
  config: ToolBrowser.Config = {},
  browserConfig: { experimentalScriptExecution?: boolean; allowFullCdpAccess?: boolean } = {},
  options: { attachments?: boolean; imageInput?: boolean } = {},
) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemorySettings)
  ctx.reflect.provide('approval', {
    request: () => Promise.resolve('allowed-once'),
  })
  ctx.reflect.provide('llm', {
    resolveModelInfo: () => Promise.resolve({
      provider: 'visual',
      id: 'vision-model',
      name: 'Vision model',
      inputModalities: options.imageInput === false ? ['text'] : ['text', 'image'],
    }),
  })
  if (options.attachments !== false) await ctx.plugin(TestAttachmentStore)
  await ctx.plugin(BrowserSessionService, { electronPath: '/fake/electron', show: false, ...browserConfig })
  const children: ScriptedChild[] = []
  ctx.browsers.spawnChild = () => {
    const child = new ScriptedChild(PAGE)
    children.push(child)
    return child
  }
  await ctx.plugin(ToolBrowser, config)

  const id = SessionId('browser-tools')
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  const scope = ctx.plugin(() => {})
  const agent: Agent = {
    id,
    options: { provider: 'visual', model: 'vision-model' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)

  // `false` means "send no agent at all"; an omitted argument uses this harness's.
  const call = (name: string, args: Record<string, unknown>, owner: Agent | false = agent) =>
    ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`${name}-call`),
      name,
      arguments: args,
      ...owner === false ? {} : { agent: owner },
    })

  return { ctx, children, agent, session, call }
}

function authorizeUpload(agent: Agent, path: string): void {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Upload exactly ${path}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function text(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-browser registration', () => {
  it('registers the browser tools and the DOM-format prompt section', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('browser_')).sort())
      .toEqual([
        'browser_back', 'browser_click', 'browser_close_tab', 'browser_history_search', 'browser_navigate',
        'browser_open_tab', 'browser_page_agent_run', 'browser_page_agent_status', 'browser_page_agent_stop',
        'browser_press', 'browser_screenshot', 'browser_scroll', 'browser_scroll_horizontally',
        'browser_select_option', 'browser_state', 'browser_switch_tab', 'browser_type',
        'browser_upload_file', 'browser_wait',
      ])
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === BROWSER_PROMPT_NAME)
    expect(section?.text).toBe(BROWSER_PROMPT_TEXT)
  })

  it('registers screenshot only while a durable attachment store is mounted', async () => {
    const { ctx } = await harness({}, {}, { attachments: false })
    expect(ctx.tools.get('browser_screenshot')).toBeUndefined()
  })

  it('refuses a non-positive character cap or timeout', () => {
    const ctx = {} as Context
    expect(() => { ToolBrowser.apply(ctx, { maxStateChars: 0 }) }).toThrow(/maxStateChars/)
    expect(() => { ToolBrowser.apply(ctx, { timeoutMs: 0 }) }).toThrow(/timeoutMs/)
  })

  it('exposes JavaScript only when explicitly enabled', async () => {
    expect((await harness()).ctx.tools.get('browser_execute_javascript')).toBeUndefined()
    const { ctx, call, children } = await harness({}, { experimentalScriptExecution: true })
    expect(ctx.tools.get('browser_execute_javascript')).toBeDefined()
    expect((await call('browser_execute_javascript', { script: 'return document.title' })).isError).toBe(false)
    expect(children[0]?.requests[0]).toEqual({
      method: 'execute_javascript',
      args: { script: 'return document.title' },
    })
  })

  it('adds and removes both elevated CDP tools with the effective setting', async () => {
    const { ctx, call, children } = await harness()
    expect(ctx.tools.get('browser_cdp_command')).toBeUndefined()
    expect(ctx.tools.get('browser_cdp_read_events')).toBeUndefined()

    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })
    expect(ctx.tools.get('browser_cdp_command')).toBeDefined()
    expect(ctx.tools.get('browser_cdp_read_events')).toBeDefined()
    const result = await call('browser_cdp_command', {
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' },
      tab_id: 2,
    })
    expect(result.isError).toBe(false)
    expect(text(result.content)).toBe('Runtime.evaluate\n{\n  "echo": {\n    "expression": "1 + 1"\n  }\n}')
    expect(children[0]?.requests).toEqual([
      { method: 'get_cdp_target', args: { tabId: 2 } },
      {
        method: 'cdp_command',
        args: {
          method: 'Runtime.evaluate',
          params: { expression: '1 + 1' },
          expectedOrigin: 'https://shop.test',
          tabId: 2,
        },
      },
    ])

    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: false })
    expect(ctx.tools.get('browser_cdp_command')).toBeUndefined()
    expect(ctx.tools.get('browser_cdp_read_events')).toBeUndefined()
  })

  it('keeps both elevated CDP tools hidden under the organization ceiling', async () => {
    const { ctx } = await harness({}, { allowFullCdpAccess: false })
    await expect(ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true }))
      .rejects.toThrow('organization policy disables full CDP access')
    expect(ctx.tools.get('browser_cdp_command')).toBeUndefined()
    expect(ctx.tools.get('browser_cdp_read_events')).toBeUndefined()
  })

  it('allows only explicit page targets to join parallel tool groups', async () => {
    const { ctx, agent } = await harness()
    const mode = (name: string, arguments_: Record<string, unknown>) => ctx.tools.executionMode({
      signal: new AbortController().signal,
      callId: CallId(`${name}-mode`),
      name,
      arguments: arguments_,
      agent,
    }).kind
    expect(mode('browser_click', { index: 1, tab_id: 1 })).toBe('parallel')
    expect(mode('browser_click', { index: 1 })).toBe('exclusive')
    expect(mode('browser_switch_tab', { tab_id: 1 })).toBe('exclusive')
  })
})

describe('browser tool calls', () => {
  it('opens the window on the first navigate and reports the action above the page', async () => {
    const { children, call } = await harness()
    const result = await call('browser_navigate', { url: 'https://shop.test/order' })
    expect(result.isError).toBeFalsy()
    expect(text(result.content)).toBe(
      'did navigate\n\nOpen tabs:\n- [1] (active) Order — https://shop.test/order (complete)\nSnapshot tab: [1]\n\nCurrent Page: [Order](https://shop.test/order)\n'
      + `${PAGE}\n[End of page]`,
    )
    expect(children).toHaveLength(1)
    expect(children[0]?.requests[0]).toEqual({ method: 'navigate', args: { url: 'https://shop.test/order' } })
  })

  it('reads the page without claiming an action was taken', async () => {
    const { call } = await harness()
    const result = await call('browser_state', {})
    expect(text(result.content).startsWith('Open tabs:')).toBe(true)
  })

  it('captures the selected viewport, persists it, and returns no raw base64', async () => {
    const { ctx, children, call } = await harness()
    const result = await call('browser_screenshot', {})

    expect(result.isError).toBe(false)
    expect(children[0]?.requests).toEqual([{ method: 'browser_screenshot', args: {} }])
    expect((ctx.attachments as TestAttachmentStore).saved[0]).toMatchObject({
      mediaType: 'image/png',
      name: 'browser-tab-1.png',
    })
    expect(Buffer.from((ctx.attachments as TestAttachmentStore).saved[0]?.data ?? [])).toEqual(PNG_1X1)
    expect(text(result.content)).toContain('Browser screenshot of tab [1] — Order')
    expect(result.content[1]).toMatchObject({
      type: 'image',
      attachment: {
        attachmentId: 'sha256:browser-screenshot',
        mediaType: 'image/png',
        bytes: PNG_1X1.length,
        width: 1,
        height: 1,
      },
    })
    expect(JSON.stringify(result)).not.toContain(PNG_1X1.toString('base64'))
  })

  it('refuses a screenshot before capture when the current model is text-only', async () => {
    const { children, call } = await harness({}, {}, { imageInput: false })
    const result = await call('browser_screenshot', {})
    expect(result.isError).toBe(true)
    expect(text(result.content)).toContain('does not declare image input')
    expect(children).toHaveLength(0)
  })

  it('searches Browser history and renders its bounded rows', async () => {
    const { children, call } = await harness()
    const result = await call('browser_history_search', { query: ' order ' })

    expect(result.isError).toBe(false)
    expect(text(result.content)).toBe(
      '- Saved order — https://shop.test/history (2026-08-26T00:00:00.000Z)',
    )
    expect(children[0]?.requests).toEqual([{
      method: 'search_browser_history',
      args: { query: 'order', limit: 20 },
    }])
  })

  it('forwards a CDP event cursor, filter, limit, and tab then renders the page cursor', async () => {
    const { ctx, children, call } = await harness()
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })
    const result = await call('browser_cdp_read_events', {
      after_sequence: 10,
      limit: 1,
      method: 'Network.responseReceived',
      tab_id: 2,
    })

    expect(result.isError).toBe(false)
    expect(text(result.content)).toBe(
      '[12] Network.responseReceived\n{"requestId":"shop-request"}\nCursor: 12',
    )
    expect(children[0]?.requests).toEqual([
      { method: 'get_cdp_target', args: { tabId: 2 } },
      {
        method: 'cdp_read_events',
        args: {
          afterSequence: 10,
          limit: 1,
          method: 'Network.responseReceived',
          expectedOrigin: 'https://shop.test',
          tabId: 2,
        },
      },
    ])
  })

  it('clicks the index it was given', async () => {
    const { children, call } = await harness()
    await call('browser_click', { index: 1 })
    expect(children[0]?.requests[0]).toEqual({ method: 'click_element', args: { index: 1 } })
  })

  it('keeps an explicit tab target on both the action and trailing state read', async () => {
    const { children, call } = await harness()
    const result = await call('browser_click', { index: 1, tab_id: 2 })
    expect(children[0]?.requests.slice(0, 2)).toEqual([
      { method: 'click_element', args: { index: 1, tabId: 2 } },
      { method: 'get_browser_state', args: { waitForReady: true, tabId: 2 } },
    ])
    expect(text(result.content)).toContain('Snapshot tab: [2] (background)')
  })

  it('forwards each remaining action in the seam vocabulary', async () => {
    const { children, call, agent } = await harness()
    authorizeUpload(agent, UPLOAD_FIXTURE)
    await call('browser_type', { index: 1, text: 'hello' })
    await call('browser_upload_file', { index: 3, path: UPLOAD_FIXTURE })
    await call('browser_select_option', { index: 2, text: 'Express' })
    await call('browser_scroll', { down: true })
    await call('browser_scroll', { down: false, num_pages: 3, pixels: 200, index: 4 })
    await call('browser_scroll_horizontally', { right: true, pixels: 300, index: 5 })
    await call('browser_wait', { seconds: 2 })
    await call('browser_press', { key: 'Enter' })
    await call('browser_back', {})
    await call('browser_open_tab', { url: 'https://shop.test/help' })
    await call('browser_switch_tab', { tab_id: 1 })
    await call('browser_close_tab', { tab_id: 2 })
    expect(children[0]?.requests.filter(request => request.method !== 'get_browser_state')).toEqual([
      { method: 'input_text', args: { index: 1, text: 'hello' } },
      { method: 'get_upload_target', args: {} },
      {
        method: 'upload_file',
        args: {
          index: 3,
          filePath: realpathSync(UPLOAD_FIXTURE),
          expectedOrigin: 'https://shop.test',
          tabId: 1,
        },
      },
      { method: 'select_option', args: { index: 2, text: 'Express' } },
      { method: 'scroll', args: { down: true, numPages: 1 } },
      { method: 'scroll', args: { down: false, numPages: 3, pixels: 200, index: 4 } },
      { method: 'scroll_horizontally', args: { right: true, pixels: 300, index: 5 } },
      { method: 'wait', args: { seconds: 2 } },
      { method: 'press', args: { key: 'Enter' } },
      { method: 'back', args: {} },
      { method: 'open_new_tab', args: { url: 'https://shop.test/help' } },
      { method: 'switch_to_tab', args: { tabId: 1 } },
      { method: 'close_tab', args: { tabId: 2 } },
    ])
  })

  it('forwards upstream PageAgent engine controls without inventing a second agent', async () => {
    const { children, call } = await harness()
    await call('browser_page_agent_run', { task: 'Find the import button' })
    await call('browser_page_agent_status', {})
    await call('browser_page_agent_stop', {})
    expect(children[0]?.requests.filter(request => request.method !== 'get_browser_state')).toEqual([
      { method: 'page_agent_run', args: { task: 'Find the import button' } },
      { method: 'page_agent_status', args: {} },
      { method: 'page_agent_stop', args: {} },
    ])
  })

  it('rejects a blank key before touching the page', async () => {
    const { children, call } = await harness()
    const result = await call('browser_press', { key: ' ' })
    expect(result.isError).toBe(true)
    expect(text(result.content)).toContain('key must be a non-empty string')
    expect(children).toHaveLength(0)
  })

  it('rejects a non-absolute upload path before starting a window', async () => {
    const { children, call, agent } = await harness()
    authorizeUpload(agent, 'artifact.json')
    const result = await call('browser_upload_file', { index: 1, path: 'artifact.json' })
    expect(result.isError).toBe(true)
    expect(text(result.content)).toContain('upload file path must be absolute')
    expect(children).toHaveLength(0)
  })

  it('rejects an upload path the user did not name in the current turn', async () => {
    const { children, call } = await harness()
    const result = await call('browser_upload_file', { index: 1, path: UPLOAD_FIXTURE })
    expect(result.isError).toBe(true)
    expect(text(result.content)).toContain('direct user message in the current open turn')
    expect(children).toHaveLength(0)
  })

  it('cuts a long element list and says so', async () => {
    const { call } = await harness({ maxStateChars: 6 })
    const result = await call('browser_state', {})
    expect(text(result.content)).toContain(ToolBrowser.TRUNCATION_NOTICE)
    expect(text(result.content)).toContain('\n[0]<in\n')
  })

  it('rejects a blank url before starting a window', async () => {
    const { children, call } = await harness()
    const result = await call('browser_navigate', { url: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result.content)).toContain('url must be a non-empty string')
    expect(children).toHaveLength(0)
  })

  it('refuses to act without an initiating agent', async () => {
    const { call } = await harness()
    const result = await call('browser_state', {}, false)
    expect(result.isError).toBe(true)
    expect(text(result.content)).toContain('browser tools require an initiating agent')
  })
})

describe('browser navigation', () => {
  it('opens any absolute http(s) origin without approval', async () => {
    const { children, call } = await harness()
    expect((await call('browser_navigate', { url: 'https://sso.test/login' })).isError).toBeFalsy()
    expect(children[0]?.requests[0]).toEqual({ method: 'navigate', args: { url: 'https://sso.test/login' } })
  })

  it.each(['order.html', 'data:text/html,<p>hi</p>', 'ftp://files.test/'])('refuses an unsupported URL: %s', async (url) => {
    const { children, call } = await harness()
    const result = await call('browser_navigate', { url })
    expect(result.isError).toBe(true)
    expect(text(result.content)).toContain('url must be an absolute http(s) URL')
    expect(children).toHaveLength(0)
  })
})

describe('browser call presentation', () => {
  it('titles each pending call from its arguments alone', async () => {
    const { ctx } = await harness()
    const present = (name: string, args: Record<string, unknown>) =>
      ctx.tools.get(name)?.presentCall?.(args)
    expect(present('browser_navigate', { url: 'https://shop.test' }))
      .toEqual({ card: 'generic', title: 'Open https://shop.test', kind: 'execute', rawInput: 'https://shop.test' })
    expect(present('browser_state', {})).toEqual({ card: 'generic', title: 'Read browser page', kind: 'execute' })
    expect(present('browser_click', { index: 12 }))
      .toEqual({ card: 'generic', title: 'Click [12]', kind: 'execute' })
    expect(present('browser_type', { index: 3, text: 'ACME' }))
      .toEqual({ card: 'generic', title: 'Type into [3]', kind: 'execute', rawInput: 'ACME' })
    expect(present('browser_upload_file', { index: 5, path: 'C:\\test\\artifact.json' }))
      .toEqual({ card: 'generic', title: 'Upload file through [5]', kind: 'execute', rawInput: 'C:\\test\\artifact.json' })
    expect(present('browser_select_option', { index: 4, text: 'Express' }))
      .toEqual({ card: 'generic', title: 'Select "Express" in [4]', kind: 'execute' })
    expect(present('browser_scroll', { down: true })).toEqual({ card: 'generic', title: 'Scroll down', kind: 'execute' })
    expect(present('browser_scroll', { down: false })).toEqual({ card: 'generic', title: 'Scroll up', kind: 'execute' })
    expect(present('browser_scroll_horizontally', { right: true, pixels: 100 })).toEqual({ card: 'generic', title: 'Scroll right', kind: 'execute' })
    expect(present('browser_wait', { seconds: 3 })).toEqual({ card: 'generic', title: 'Wait 3s for browser page', kind: 'execute' })
    expect(present('browser_press', { key: 'Tab' })).toEqual({ card: 'generic', title: 'Press Tab', kind: 'execute' })
    expect(present('browser_back', {})).toEqual({ card: 'generic', title: 'Go back', kind: 'execute' })
    expect(present('browser_history_search', { query: 'orders' }))
      .toEqual({ card: 'generic', title: 'Search Browser history', kind: 'execute', rawInput: 'orders' })
    expect(present('browser_open_tab', { url: 'https://shop.test/help' })).toEqual({ card: 'generic', title: 'Open tab https://shop.test/help', kind: 'execute', rawInput: 'https://shop.test/help' })
    expect(present('browser_switch_tab', { tab_id: 2 })).toEqual({ card: 'generic', title: 'Switch to tab [2]', kind: 'execute' })
    expect(present('browser_close_tab', { tab_id: 2 })).toEqual({ card: 'generic', title: 'Close tab [2]', kind: 'execute' })
  })
})
