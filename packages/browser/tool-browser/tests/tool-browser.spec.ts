import { saveBrowserArtifact } from '../src/artifact.ts'
import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import { AttachmentId, AttachmentStore } from '@hydra/harness-attachment'
import type {
  ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment,
} from '@hydra/harness-attachment'
import { CallId, createUserMessage } from '@hydra/harness-llm'
import type { ContentBlock } from '@hydra/harness-llm'
import { Session, SessionId } from '@hydra/harness-session'
import AgentRegistry, { Inbox } from '@hydra/harness-agent'
import type { Agent } from '@hydra/harness-agent'
import SystemPrompt from '@hydra/harness-system-prompt'
import ToolRuntime from '@hydra/harness-tools'
import { SettingsProvider } from '@hydra/harness-settings'
import type { SettingsNamespace } from '@hydra/harness-settings'
import BrowserSessionService, { BROWSER_SETTINGS_NAMESPACE } from '@hydra/harness-browser-electron'
import type { BrowserChildProcess } from '@hydra/harness-browser-electron'
import * as ToolBrowser from '@hydra/harness-tool-browser'
import {
  BROWSER_PROMPT_NAME, BROWSER_PROMPT_TEXT, COMPACT_NOTICE, compactHeader, dropIgnoredNodes, formatBrowserOutput,
  rankElementList, toValue,
} from '@hydra/harness-tool-browser'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

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
  readonly responses = new Map<string, unknown>()

  constructor(private readonly content: string) {
    super()
    this.stdin.on('finish', () => this.emit('exit'))
    createInterface({ input: this.stdin }).on('line', (line: string) => {
      const { id, method, args } = JSON.parse(line) as { id: number; method: string; args: Record<string, unknown> }
      this.requests.push({ method, args })
      const result = this.responses.has(method) ? this.responses.get(method) : method === 'get_browser_state'
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
                    : method === 'select_text'
                      ? { success: true, message: 'Selected text: "Ada".', selectedText: 'Ada' }
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

it('removes an allocated artifact directory when writing fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-artifact-failure-'))
  const failure = new Error('disk full')
  const write = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure)
  try {
    await expect(saveBrowserArtifact(directory, 'capture.txt', 'data', new AbortController().signal)).rejects.toBe(failure)
    expect(await readdir(directory)).toEqual([])
  } finally {
    write.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})

class TestAttachmentStore extends AttachmentStore {
  readonly saved: SaveImageAttachment[] = []
  get imageLimits(): ImageAttachmentLimits { return Object.freeze({
    maxImageBytes: 3_500_000,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 3_500_000,
    maxImagePixels: 4_000_000,
    maxImageDimension: 2_000,
    mediaTypes: Object.freeze(['image/png'] as const),
  }) }

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
  options: { attachments?: boolean; imageInput?: boolean | 'unknown'; llm?: boolean; direct?: boolean } = {},
) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemorySettings)
  ctx.reflect.provide('approval', {
    request: () => Promise.resolve('allowed-once'),
  })
  if (options.llm !== false) ctx.reflect.provide('llm', {
    resolveModelInfo: () => Promise.resolve({
      provider: 'visual',
      id: 'vision-model',
      name: 'Vision model',
      ...options.imageInput === 'unknown' ? {} : { inputModalities: options.imageInput === false ? ['text'] : ['text', 'image'] },
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
  await ctx.plugin(options.direct === true
    ? { inject: ToolBrowser.inject, apply: (scope) => { ToolBrowser.apply(scope) } }
    : ToolBrowser, config)

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
  it('validates output configuration even when apply is called directly', async () => {
    const { ctx } = await harness({}, {}, { direct: true })
    for (const config of [{ outputDir: 'relative' }, { snapshotMode: 'invalid' }, { imageResponses: 'invalid' }, { consoleLevel: 'invalid' }]) {
      expect(() =>{  ToolBrowser.apply(ctx, config as ToolBrowser.Config) }).toThrow(/absolute|configuration/)
    }
    await ctx.fiber.dispose()
  })

  it.each([{ llm: false }, { imageInput: 'unknown' as const }])('refuses capture without a declared image route %j', async (options) => {
    const { call, children } = await harness({}, {}, options)
    expect((await call('browser_screenshot', {})).isError).toBe(true)
    expect(children).toHaveLength(0)
  })

  it('requires a complete model route and deployment PNG support', async () => {
    const { ctx, call, agent, children } = await harness()
    expect((await call('browser_screenshot', {}, { ...agent, options: {} })).isError).toBe(true)
    const limits = vi.spyOn(TestAttachmentStore.prototype, 'imageLimits', 'get')
      .mockReturnValue({ ...ctx.attachments.imageLimits, mediaTypes: ['image/jpeg'] })
    try {
      expect(text((await call('browser_screenshot', {})).content)).toContain('PNG images are not accepted')
      expect(children).toHaveLength(0)
    } finally { limits.mockRestore() }
  })

  it('handles attachment stores returning no image, a different format, or an unnamed PNG', async () => {
    const { call, ctx } = await harness()
    const save = vi.spyOn(TestAttachmentStore.prototype, 'saveImages')
    try {
      for (const images of [[], [{ attachmentId: AttachmentId('image'), mediaType: 'image/jpeg' as const, bytes: 1, width: 1, height: 1 }]]) {
        save.mockResolvedValueOnce(images)
        expect(text((await call('browser_screenshot', {})).content)).toContain('did not return a PNG')
      }
      save.mockResolvedValueOnce([{ attachmentId: AttachmentId('image'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }])
      const captured = await call('browser_screenshot', {})
      expect(captured.isError).toBe(false)
      expect(captured.content.find(block => block.type === 'image')?.attachment).not.toHaveProperty('name')
    } finally { save.mockRestore(); await ctx.fiber.dispose() }
  })

  it('rejects invalid tool JSON before performing an action', async () => {
    const { call, children, ctx } = await harness({}, { experimentalScriptExecution: true })
    const cases: [string, Record<string, unknown>][] = [
      ['browser_snapshot', { target: ' ' }], ['browser_wait', { seconds: 0 }],
      ['browser_wait_for', {}], ['browser_wait_for', { time: 11 }],
      ['browser_tabs', { action: 'close' }], ['browser_tabs', { action: 'select', index: 0 }], ['browser_tabs', { action: 'new', url: 'file:///x' }],
      ['browser_drag', { start_index: -1, end_index: 1 }], ['browser_drop', { index: -1 }],
      ['browser_drop', { index: 1 }], ['browser_drop', { index: 1, data: { invalid: 'text' } }],
      ['browser_drop', { index: 1, data: { 'text/plain': 1 } }],
      ['browser_resize', { width: 0, height: 1 }], ['browser_resize', { width: 1, height: 8193 }],
      ['browser_network_request', { index: 0 }], ['browser_scroll_horizontally', { right: true, pixels: 0 }],
      ['browser_find', { regex: ' ' }], ['browser_fill_form', { fields: [] }],
      ['browser_history_search', { query: ' ' }], ['browser_history_search', { query: 'x'.repeat(257) }],
      ['browser_open_tab', { url: ' ' }], ['browser_open_tab', { url: 'file:///x' }],
      ['browser_page_agent_run', { task: ' ' }], ['browser_execute_javascript', { script: ' ' }], ['browser_evaluate', { script: ' ' }],
    ]
    for (const [name, args] of cases) expect((await call(name, args)).isError, `${name}: ${JSON.stringify(args)}`).toBe(true)
    expect(children).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('forwards optional actions and renders tab lifecycle failures', async () => {
    const { call, children, ctx } = await harness({}, { experimentalScriptExecution: true })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { navigationPolicy: 'allow' })
    for (const [name, args, method, expected] of [
      ['browser_wait_for', { text: 'loaded', text_gone: 'loading' }, 'wait_for', { seconds: 10, text: 'loaded', textGone: 'loading' }],
      ['browser_wait_for', { time: 1 }, 'wait_for', { seconds: 1 }],
      ['browser_tabs', { action: 'new' }, 'open_new_tab', {}],
      ['browser_tabs', { action: 'new', url: 'https://example.test' }, 'open_new_tab', { url: 'https://example.test' }],
      ['browser_tabs', { action: 'close', index: 2 }, 'close_tab', { tabId: 2 }],
      ['browser_tabs', { action: 'select', index: 1 }, 'switch_to_tab', { tabId: 1 }],
      ['browser_handle_dialog', { accept: false }, 'handle_dialog', { accept: false }],
      ['browser_handle_dialog', { accept: true, promptText: 'Ada' }, 'handle_dialog', { accept: true, promptText: 'Ada' }],
      ['browser_network_request', { index: 1 }, 'network_request', { index: 1 }],
      ['browser_scroll_horizontally', { right: false, pixels: 10 }, 'scroll_horizontally', { right: false, pixels: 10 }],
      ['browser_find', { text: 'Order' }, 'find_element', { text: 'Order' }],
      ['browser_find', { regex: 'Order' }, 'find_element', { regex: 'Order' }],
      ['browser_open_tab', {} , 'open_new_tab', {}],
      ['browser_navigate_back', {}, 'back', {}], ['browser_evaluate', { script: 'return 1' }, 'execute_javascript', { script: 'return 1' }],
    ] as const) {
      expect((await call(name, args)).isError, name).toBe(false)
      expect(children[0]!.requests).toContainEqual({ method, args: expected })
    }
    children[0]!.responses.set('close_tab', { success: false, message: 'last tab' })
    expect(text((await call('browser_tabs', { action: 'close', index: 1 })).content)).toContain('last tab')
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })
    ctx.emit('browser/full-cdp-access', true)
    expect((await call('browser_cdp_command', { method: 'Runtime.enable' })).isError).toBe(false)
    const events = await call('browser_cdp_read_events', {})
    expect(events.isError).toBe(false)
    expect(text((await call('browser_cdp_read_events', { after_sequence: 12 })).content)).toContain('No matching CDP events')
    expect(text((await call('browser_close', {})).content)).toBe('Browser closed.')
    expect(text((await call('browser_close', {})).content)).toBe('Browser was already closed.')
    await ctx.fiber.dispose()
  })

  it('renders history without titles and an empty result list', async () => {
    const { call, children, ctx } = await harness()
    await call('browser_state', {})
    children[0]!.responses.set('search_browser_history', [{ url: 'https://example.test', title: '', visitedAt: 'today' }])
    expect(text((await call('browser_history_search', { query: 'page' })).content)).toContain('- https://example.test')
    children[0]!.responses.set('search_browser_history', [])
    expect(text((await call('browser_history_search', { query: 'page' })).content)).toBe('No matching Browser history entries.')
    await ctx.fiber.dispose()
  })

  it('renders inactive tabs, untitled screenshots and legacy snapshot metadata', async () => {
    const { call, ctx, children } = await harness()
    const state = { url: 'https://example.test', title: '', header: '', content: '[1]<button>Save</button>', footer: '',
      tabs: [{ id: 1, url: 'https://example.test', title: 'One', status: 'complete', active: true },
        { id: 2, url: 'https://example.test/two', title: 'Two', status: 'complete', active: false }],
      tabId: 1, activeTabId: 1, settled: true, capturedAt: '2026-09-01', truncated: false, compact: false, unchanged: false }
    const output = ctx.tools.get('browser_state')!.output
    expect(output.presentationMeta?.({}, state)).toHaveProperty('browser', { tabId: 1, revision: 1, mode: 'full', hash: ToolBrowser.contentHash(state.content) })
    const changes = { shown: [], hidden: [], expanded: [], collapsed: [], changed: [] }
    expect(output.presentationMeta?.({}, { ...state, uiChanges: changes })).toHaveProperty('browser.hash', ToolBrowser.contentHash(`${state.content}\n${JSON.stringify(changes)}`))
    await call('browser_state', {})
    children[0]!.responses.set('get_browser_state', state)
    expect(text((await call('browser_tabs', { action: 'list' })).content)).toContain('[2] Two')
    children[0]!.responses.set('browser_screenshot', { mediaType: 'image/png', data: PNG_1X1.toString('base64'), bytes: PNG_1X1.length,
      width: 1, height: 1, tabId: 1, url: state.url, title: '', capturedAt: '2026-09-01' })
    expect(text((await call('browser_screenshot', {})).content)).toContain('— https://example.test')
    await ctx.fiber.dispose()
  })

  it('bounds diagnostics and saves an empty reply without retaining an obsolete tab snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-diagnostics-'))
    const { call, children, ctx } = await harness({ maxStateChars: 10, outputDir: directory })
    try {
      await call('browser_state', {})
      expect(text((await call('browser_console_messages', {})).content)).toContain('Output truncated')
      children[0]!.responses.set('console_messages', undefined)
      const empty = (await call('browser_console_messages', { filename: 'empty.txt' })).value as unknown as ToolBrowser.BrowserToolValue
      expect(await readFile(empty.filename!, 'utf8')).toBe('')
    } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('registers the browser tools and the accessibility-snapshot prompt section', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('browser_')).sort())
      .toEqual([
        'browser_back', 'browser_click', 'browser_close', 'browser_close_tab', 'browser_console_messages', 'browser_drag', 'browser_drop', 'browser_file_upload', 'browser_fill', 'browser_fill_form',
        'browser_find', 'browser_forward', 'browser_history_search', 'browser_navigate', 'browser_navigate_back',
        'browser_open_tab', 'browser_page_agent_run', 'browser_page_agent_status', 'browser_page_agent_stop',
        'browser_press', 'browser_press_key', 'browser_screenshot', 'browser_scroll', 'browser_scroll_horizontally',
        'browser_select_option', 'browser_select_text', 'browser_resize', 'browser_snapshot', 'browser_state', 'browser_switch_tab', 'browser_tabs',
        'browser_take_screenshot', 'browser_type', 'browser_upload_file', 'browser_wait', 'browser_wait_for', 'browser_handle_dialog', 'browser_hover', 'browser_network_request', 'browser_network_requests',
      ].sort())
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === BROWSER_PROMPT_NAME)
    expect(section?.text).toBe(BROWSER_PROMPT_TEXT)
  })

  it('keeps file capture available without an attachment store but refuses image delivery', async () => {
    const { ctx, call, children } = await harness({}, {}, { attachments: false })
    expect(ctx.tools.get('browser_screenshot')).toBeDefined()
    expect((await call('browser_screenshot', {})).isError).toBe(true)
    expect(children).toHaveLength(0)
  })

  it('keeps prompt and schemas byte-stable across a browser call', async () => {
    const { ctx, call } = await harness()
    const beforeSchemas = JSON.stringify(ctx.tools.schemas())
    const beforePrompt = JSON.stringify(await ctx.systemPrompt.assemble())
    expect((await call('browser_state', {})).isError).toBe(false)
    expect(JSON.stringify(ctx.tools.schemas())).toBe(beforeSchemas)
    expect(JSON.stringify(await ctx.systemPrompt.assemble())).toBe(beforePrompt)
  })

  it('routes accessibility actions and file drops through the browser permissions', async () => {
    const { ctx, call, children } = await harness()
    for (const [name, args] of [
      ['browser_hover', { index: 1 }],
      ['browser_drag', { start_index: 0, end_index: 1 }],
      ['browser_resize', { width: 800, height: 600 }],
      ['browser_handle_dialog', { accept: false }],
      ['browser_console_messages', {}],
      ['browser_network_requests', {}],
      ['browser_network_request', { index: 1, part: 'response-body' }],
      ['browser_wait_for', { text: 'Order' }],
      ['browser_drop', { index: 1, paths: [UPLOAD_FIXTURE], data: { 'text/plain': 'Order' } }],
    ] as const) expect((await call(name, args)).isError, name).toBe(false)
    expect(children[0]?.requests).toContainEqual({ method: 'drop', args: { index: 1, filePaths: [realpathSync(UPLOAD_FIXTURE)], data: { 'text/plain': 'Order' }, expectedOrigin: 'https://shop.test', tabId: 1 } })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { browserPermissions: { browsing: 'allow', uploads: 'block', downloads: 'allow' } })
    expect((await call('browser_drop', { index: 1, paths: [UPLOAD_FIXTURE] })).isError).toBe(true)
    expect((await call('browser_drop', { index: 1, data: { 'text/plain': 'Allowed text' } })).isError).toBe(false)
    expect((await call('browser_drop', { index: 1, data: { 'text/plain': 123 } })).isError).toBe(true)
    expect((await call('browser_wait_for', { time: -1 })).isError).toBe(true)
    expect((await call('browser_close', {})).isError).toBe(false)
    expect((await call('browser_snapshot', {})).isError).toBe(false)
    expect(children).toHaveLength(2)
  })

  it('routes MCP-shaped aliases through the existing browser seam', async () => {
    const { call, children } = await harness()
    expect((await call('browser_snapshot', {})).isError).toBe(false)
    expect((await call('browser_fill_form', { fields: [{ index: 1, text: 'Ada' }] })).isError).toBe(false)
    expect((await call('browser_press_key', { key: 'Enter' })).isError).toBe(false)
    expect(children[0]?.requests.map(request => request.method)).toEqual([
      'get_browser_state', 'fill_fields', 'get_browser_state', 'press', 'get_browser_state',
    ])
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
    expect(children[0]?.requests[0]).toEqual({ method: 'navigate', args: { url: 'https://shop.test/order', navigationApproved: true } })
  })

  it('reads the page without claiming an action was taken', async () => {
    const { call } = await harness()
    const result = await call('browser_state', {})
    expect(text(result.content).startsWith('Open tabs:')).toBe(true)
    expect(text(result.content)).not.toContain(COMPACT_NOTICE)
  })

  it('returns a compact snapshot after an ordinary action', async () => {
    const { call } = await harness()
    const result = await call('browser_click', { index: 1 })
    expect(text(result.content)).toContain('Tab [1] (active) Order — https://shop.test/order')
    expect(text(result.content)).toContain(COMPACT_NOTICE)
    expect(text(result.content)).not.toContain('Open tabs:')
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

  it('clicks a named control without inventing an index', async () => {
    const { children, call } = await harness()
    await call('browser_click', { name: 'Place order' })
    expect(children[0]?.requests[0]).toEqual({ method: 'click_element', args: { name: 'Place order' } })
  })

  it('rejects a click that names neither an index nor a name', async () => {
    const { children, call } = await harness()
    const missing = await call('browser_click', {})
    expect(missing.isError).toBe(true)
    expect(text(missing.content)).toContain('provide index or a non-empty name')
    const blank = await call('browser_click', { name: '   ' })
    expect(blank.isError).toBe(true)
    expect(text(blank.content)).toContain('provide index or a non-empty name')
    expect(children).toHaveLength(0)
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
    await call('browser_select_text', { index: 2 })
    await call('browser_scroll', { down: true })
    await call('browser_scroll', { down: false, num_pages: 3, pixels: 200, index: 4 })
    await call('browser_scroll_horizontally', { right: true, pixels: 300, index: 5 })
    await call('browser_wait', { seconds: 2 })
    await call('browser_press', { key: 'Enter' })
    await call('browser_back', {})
    await call('browser_forward', {})
    await call('browser_find', { query: 'Requester' })
    await call('browser_fill', { fields: [{ name: 'who', text: 'Ada' }] })
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
      { method: 'select_text', args: { index: 2 } },
      { method: 'scroll', args: { down: true, numPages: 1 } },
      { method: 'scroll', args: { down: false, numPages: 3, pixels: 200, index: 4 } },
      { method: 'scroll_horizontally', args: { right: true, pixels: 300, index: 5 } },
      { method: 'wait', args: { seconds: 2 } },
      { method: 'press', args: { key: 'Enter' } },
      { method: 'back', args: {} },
      { method: 'forward', args: {} },
      { method: 'find_element', args: { query: 'Requester' } },
      { method: 'fill_fields', args: { fields: [{ name: 'who', text: 'Ada' }] } },
      { method: 'open_new_tab', args: { url: 'https://shop.test/help', navigationApproved: true } },
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

  it('rejects a blank find query or empty fill list before touching the page', async () => {
    const { children, call } = await harness()
    const find = await call('browser_find', { query: '   ' })
    expect(find.isError).toBe(true)
    expect(text(find.content)).toContain('query must be a non-empty string')
    const fill = await call('browser_fill', { fields: [] })
    expect(fill.isError).toBe(true)
    expect(text(fill.content)).toContain('fields must be a non-empty array')
    const unnamed = await call('browser_fill', { fields: [{ text: 'Ada' }] })
    expect(unnamed.isError).toBe(true)
    expect(text(unnamed.content)).toContain('provide index or a non-empty name')
    expect(children).toHaveLength(0)
  })

  it('forwards select_text with explicit coordinates or named targets and rejects empty arguments', async () => {
    const { children, call } = await harness()
    await call('browser_select_text', { start_x: 10, start_y: 20, end_x: 100, end_y: 20 })
    const selection = await call('browser_select_text', { name: 'Title' })
    expect(selection.isError).toBe(false)
    expect(text(selection.content)).toContain('Selected text: "Ada".')
    expect(children[0]?.requests.filter(request => request.method !== 'get_browser_state')).toEqual([
      { method: 'select_text', args: { startX: 10, startY: 20, endX: 100, endY: 20 } },
      { method: 'select_text', args: { name: 'Title' } },
    ])
    const empty = await call('browser_select_text', {})
    expect(empty.isError).toBe(true)
    expect(text(empty.content)).toContain('provide index, a non-empty name, or start and end coordinates')
    for (const coordinates of [{ start_x: 10, end_x: 100 }, { start_x: -1, start_y: 20, end_x: 100, end_y: 20 }]) {
      const invalid = await call('browser_select_text', coordinates)
      expect(invalid.isError).toBe(true)
      expect(text(invalid.content)).toContain('all four finite, non-negative coordinates')
    }
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

  it('uploads an approved local artifact without a user path literal', async () => {
    const { children, call } = await harness()
    const result = await call('browser_upload_file', { index: 1, path: UPLOAD_FIXTURE })
    expect(result.isError).not.toBe(true)
    expect(children[0]?.requests).toContainEqual(expect.objectContaining({ method: 'upload_file' }))
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
  it('opens an absolute http(s) origin after browsing approval', async () => {
    const { children, call } = await harness()
    expect((await call('browser_navigate', { url: 'https://sso.test/login' })).isError).toBeFalsy()
    expect(children[0]?.requests[0]).toEqual({ method: 'navigate', args: { url: 'https://sso.test/login', navigationApproved: true } })
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
  it('titles aliases, optional targets and elevated tools before execution', async () => {
    const { ctx } = await harness({}, { experimentalScriptExecution: true })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })
    for (const [name, args, title] of [
      ['browser_screenshot', {}, 'Capture selected browser viewport'], ['browser_close', {}, 'Close browser'],
      ['browser_snapshot', {}, 'Read accessibility snapshot'], ['browser_wait_for', {}, 'Wait for browser state'],
      ['browser_tabs', { action: 'list' }, 'List browser tabs'], ['browser_click', { target: '#save' }, 'Click #save'],
      ['browser_hover', {}, 'Hover browser control'], ['browser_drag', { start_index: 1, end_index: 2 }, 'Drag browser control'],
      ['browser_drop', { index: 1 }, 'Drop files or data into browser'], ['browser_resize', { width: 800, height: 600 }, 'Resize browser to 800 × 600'],
      ['browser_handle_dialog', { accept: true }, 'Accept browser dialog'], ['browser_handle_dialog', { accept: false }, 'Dismiss browser dialog'],
      ['browser_console_messages', {}, 'Read browser console'], ['browser_network_requests', {}, 'Read browser network requests'],
      ['browser_network_request', { index: 3 }, 'Read browser request 3'], ['browser_type', { target: '#name', text: 'Ada' }, 'Type into #name'],
      ['browser_select_option', { name: 'Color', text: 'Red' }, 'Select "Red" in Color'],
      ['browser_select_option', { target: '#color', text: 'Red' }, 'Select "Red" in #color'],
      ['browser_select_text', { target: '#title' }, 'Select text in #title'], ['browser_select_text', {}, 'Select text across range'],
      ['browser_scroll_horizontally', { right: false, pixels: 10 }, 'Scroll left'], ['browser_navigate_back', {}, 'Navigate back'],
      ['browser_find', { text: 'Ada' }, 'Find browser control'], ['browser_find', { regex: 'Ada' }, 'Find browser control'],
      ['browser_fill_form', { fields: [] }, 'Fill 0 browser fields'], ['browser_open_tab', {}, 'Open browser tab'],
      ['browser_page_agent_run', { task: 'Inspect' }, 'Run upstream PageAgent'], ['browser_page_agent_status', {}, 'Read upstream PageAgent status'],
      ['browser_page_agent_stop', {}, 'Stop upstream PageAgent'], ['browser_execute_javascript', { script: 'return 1' }, 'Execute browser JavaScript'],
      ['browser_evaluate', { script: 'return 1' }, 'Evaluate browser JavaScript'], ['browser_cdp_command', { method: 'Runtime.enable' }, 'Run CDP Runtime.enable'],
      ['browser_cdp_read_events', {}, 'Read Browser CDP events'],
    ] as const) expect(ctx.tools.get(name)?.presentCall?.(args)).toMatchObject({ title })
    await ctx.fiber.dispose()
  })

  it('titles each pending call from its arguments alone', async () => {
    const { ctx } = await harness()
    const present = (name: string, args: Record<string, unknown>) =>
      ctx.tools.get(name)?.presentCall?.(args)
    expect(present('browser_navigate', { url: 'https://shop.test' }))
      .toEqual({ card: 'generic', title: 'Open https://shop.test', kind: 'execute', rawInput: 'https://shop.test' })
    expect(present('browser_state', {})).toEqual({ card: 'generic', title: 'Read browser page', kind: 'execute' })
    expect(present('browser_click', { index: 12 }))
      .toEqual({ card: 'generic', title: 'Click [12]', kind: 'execute' })
    expect(present('browser_click', { name: 'Place order' }))
      .toEqual({ card: 'generic', title: 'Click Place order', kind: 'execute' })
    expect(present('browser_type', { index: 3, text: 'ACME' }))
      .toEqual({ card: 'generic', title: 'Type into [3]', kind: 'execute', rawInput: 'ACME' })
    expect(present('browser_type', { name: 'Requester', text: 'Ada' }))
      .toEqual({ card: 'generic', title: 'Type into Requester', kind: 'execute', rawInput: 'Ada' })
    expect(present('browser_upload_file', { index: 5, path: 'C:\\test\\artifact.json' }))
      .toEqual({ card: 'generic', title: 'Upload file through [5]', kind: 'execute', rawInput: 'C:\\test\\artifact.json' })
    expect(present('browser_select_option', { index: 4, text: 'Express' }))
      .toEqual({ card: 'generic', title: 'Select "Express" in [4]', kind: 'execute' })
    expect(present('browser_select_text', { index: 4 }))
      .toEqual({ card: 'generic', title: 'Select text in [4]', kind: 'execute' })
    expect(present('browser_select_text', { name: 'Title' }))
      .toEqual({ card: 'generic', title: 'Select text in Title', kind: 'execute' })
    expect(present('browser_scroll', { down: true })).toEqual({ card: 'generic', title: 'Scroll down', kind: 'execute' })
    expect(present('browser_scroll', { down: false })).toEqual({ card: 'generic', title: 'Scroll up', kind: 'execute' })
    expect(present('browser_scroll_horizontally', { right: true, pixels: 100 })).toEqual({ card: 'generic', title: 'Scroll right', kind: 'execute' })
    expect(present('browser_wait', { seconds: 3 })).toEqual({ card: 'generic', title: 'Wait 3s for browser page', kind: 'execute' })
    expect(present('browser_press', { key: 'Tab' })).toEqual({ card: 'generic', title: 'Press Tab', kind: 'execute' })
    expect(present('browser_back', {})).toEqual({ card: 'generic', title: 'Go back', kind: 'execute' })
    expect(present('browser_forward', {})).toEqual({ card: 'generic', title: 'Go forward', kind: 'execute' })
    expect(present('browser_find', { query: 'Requester' }))
      .toEqual({ card: 'generic', title: 'Find browser control', kind: 'execute', rawInput: 'Requester' })
    expect(present('browser_fill', { fields: [{ name: 'who', text: 'Ada' }] }))
      .toEqual({ card: 'generic', title: 'Fill 1 browser fields', kind: 'execute' })
    expect(present('browser_history_search', { query: 'orders' }))
      .toEqual({ card: 'generic', title: 'Search Browser history', kind: 'execute', rawInput: 'orders' })
    expect(present('browser_open_tab', { url: 'https://shop.test/help' })).toEqual({ card: 'generic', title: 'Open tab https://shop.test/help', kind: 'execute', rawInput: 'https://shop.test/help' })
    expect(present('browser_switch_tab', { tab_id: 2 })).toEqual({ card: 'generic', title: 'Switch to tab [2]', kind: 'execute' })
    expect(present('browser_close_tab', { tab_id: 2 })).toEqual({ card: 'generic', title: 'Close tab [2]', kind: 'execute' })
  })
})

describe('browser snapshot ranking', () => {
  it('drops only explicitly ignored accessibility nodes without changing indexes', () => {
    expect(dropIgnoredNodes([
      '[4]<div aria-hidden="true">decoration</div>',
      '[7]<div role="presentation">layout</div>',
      '[9]<div role="none">layout</div>',
      '[8]<div inert>inactive</div>',
      '[12]<button>Save</button>',
    ].join('\n'))).toBe('[12]<button>Save</button>')
  })

  it('does not drop a control whose own text happens to match an ignored marker', () => {
    expect(dropIgnoredNodes([
      '[3]<button>Mark account inert</button>',
      '[5]<a href=/policy>See our inert gas safety policy</a>',
      '[9]<div role="presentation">layout</div>',
    ].join('\n'))).toBe('[3]<button>Mark account inert</button>\n[5]<a href=/policy>See our inert gas safety policy</a>')
  })

  it('does not drop a control whose attribute value happens to equal an ignored marker', () => {
    expect(dropIgnoredNodes([
      '[4]<button data-state=inert>Retry</button>',
      '[6]<a href=inert.html>Details</a>',
      '[2]<a href=/docs?role=none>Docs</a>',
      '[3]<a href=/guide?role=presentation>Guide</a>',
      '[7]<input aria-label=aria-hidden=true/>',
      '[5]<button title=role=none>Lock</button>',
      '[8]<div inert>inactive</div>',
      '[10]<input disabled inert/>',
    ].join('\n'))).toBe([
      '[4]<button data-state=inert>Retry</button>',
      '[6]<a href=inert.html>Details</a>',
      '[2]<a href=/docs?role=none>Docs</a>',
      '[3]<a href=/guide?role=presentation>Guide</a>',
      '[7]<input aria-label=aria-hidden=true/>',
      '[5]<button title=role=none>Lock</button>',
    ].join('\n'))
  })

  it('drops empty non-indexed containers but keeps indexed empty controls', () => {
    expect(dropIgnoredNodes('<div></div>\n[4]<div></div>\n[5]<input/>'))
      .toBe('[4]<div></div>\n[5]<input/>')
    expect(dropIgnoredNodes('Page text\n[6]<input inert')).toBe('Page text')
  })

  it('keeps newly appeared and typical form controls ahead of other indexed lines', () => {
    expect(rankElementList([
      '[9]<div>User form</div>',
      '\t*[11]<button>Save</button>',
      '[10]<span>hint</span>',
      '[8]<input id=who/>',
      '[12]<textbox>Name</textbox>',
      'plain text',
    ].join('\n')).split('\n')).toEqual([
      '\t*[11]<button>Save</button>',
      '[8]<input id=who/>',
      '[12]<textbox>Name</textbox>',
      '[9]<div>User form</div>',
      '[10]<span>hint</span>',
      'plain text',
    ])
  })

  it('caps a compact value below the full state budget', () => {
    const content = `${'[0]<div>padding</div>\n'.repeat(400)}[1]<input id=who/>`
    const value = toValue({
      action: { success: true, message: 'did click' },
      state: {
        url: 'https://shop.test/order',
        title: 'Order',
        header: 'Current Page: [Order](https://shop.test/order)\nPage info: 1280x900px viewport, 0.0 pages above, 2.0 pages below',
        content,
        footer: '[End of page]',
        tabs: [{ id: 1, url: 'https://shop.test/order', title: 'Order', status: 'complete', active: true }],
        tabId: 1,
        activeTabId: 1,
        settled: true,
        capturedAt: '2026-09-07T00:00:00.000Z',
      },
    }, 16_000, { compact: true })
    expect(value.compact).toBe(true)
    expect(value.unchanged).toBe(false)
    expect(value.content.length).toBeLessThanOrEqual(4_000)
    expect(value.content).toContain('[1]<input id=who/>')
    expect(value.header).toContain('1280x900 viewport')
  })

  it('emits an unchanged compact result when the normalized element list repeats', () => {
    const value = toValue({
      action: { success: true, message: 'did wait' },
      state: {
        url: 'https://shop.test/order',
        title: 'Order',
        header: 'Current Page: [Order](https://shop.test/order)',
        content: '[1]<button>Save</button>',
        footer: '[End of page]',
        tabs: [{ id: 1, url: 'https://shop.test/order', title: 'Order', status: 'complete', active: true }],
        tabId: 1,
        activeTabId: 1,
        settled: true,
        capturedAt: '2026-09-07T00:00:00.000Z',
      },
    }, 16_000, {
      compact: true,
      previousContent: '[1]<button>Save</button>',
      previousUrl: 'https://shop.test/order',
    })
    expect(value).toMatchObject({ content: '', compact: true, unchanged: true, truncated: false })
    expect(formatBrowserOutput(value)).toContain('Page content unchanged since the previous browser result.')
  })

  it('emits a same-tab structural diff and preserves indexes', () => {
    const value = toValue({
      action: { success: true, message: 'did click' },
      state: {
        url: 'https://shop.test/order', title: 'Order', header: 'Current Page: Order',
        content: '[1]<button>Save</button>\n[2]<p>Done</p>', footer: '[End of page]',
        tabs: [{ id: 1, url: 'https://shop.test/order', title: 'Order', status: 'complete', active: true }],
        tabId: 1, activeTabId: 1, settled: true, capturedAt: '2026-09-07T00:00:00.000Z',
      },
    }, 16_000, {
      compact: true, previousUrl: 'https://shop.test/order', previousRevision: 3,
      previousContent: '[1]<button>Save</button>', previousElements: ['[1]<button>Save</button>'],
    })
    expect(value).toMatchObject({ mode: 'diff', baseRevision: 3, revision: 4, added: ['[2]<p>Done</p>'], removed: [] })
    expect(formatBrowserOutput(value)).toContain('Snapshot revision: 3 → 4')
  })

  it('retains plain page text alongside indexed controls', () => {
    const value = toValue({ state: {
      url: 'https://example.test', title: 'Page', header: 'Page', content: 'Page text\n[1]<input/>', footer: '',
      tabs: [], settled: true, capturedAt: '2026-09-07T00:00:00.000Z',
      tabId: 1, activeTabId: 1,
    } }, 1000)
    expect(value.content).toContain('Page text')
    expect(value.content).toContain('[1]<input/>')
  })

  it('renders observer changes for action prioritization', () => {
    const value = toValue({
      action: { success: true, message: 'did click' },
      state: {
        url: 'https://shop.test/order', title: 'Order', header: 'Current Page: Order',
        content: '[1]<button expanded="true">More</button>\n[2]<dialog>Details</dialog>', footer: '[End of page]',
        uiChanges: {
          shown: ['[2]<dialog>Details</dialog>'], hidden: [],
          expanded: ['[1]<button expanded="true">More</button>'], collapsed: [],
          changed: ['[1]<button expanded="true">More</button>'],
        },
        tabs: [{ id: 1, url: 'https://shop.test/order', title: 'Order', status: 'complete', active: true }],
        tabId: 1, activeTabId: 1, settled: true, capturedAt: '2026-09-07T00:00:00.000Z',
      },
    }, 16_000, {
      compact: true, previousUrl: 'https://shop.test/order', previousRevision: 1,
      previousElements: ['[1]<button expanded="false">More</button>'],
    })
    expect(value.uiChanges).toEqual({
      shown: ['[2]<dialog>Details</dialog>'], hidden: [],
      expanded: ['[1]<button expanded="true">More</button>'], collapsed: [],
      changed: ['[1]<button expanded="true">More</button>'],
    })
    expect(formatBrowserOutput(value)).toContain('Shown:\n[2]<dialog>Details</dialog>')
    expect(formatBrowserOutput(value)).toContain('Expanded:\n[1]<button expanded="true">More</button>')
    const outcome = { state: value }
    expect(toValue(outcome, 16_000).uiChanges).toBeUndefined()
    const bounded = toValue(outcome, 20, { previousUrl: value.url, previousRevision: 1 })
    expect(bounded.uiChanges?.shown[0]).toHaveLength(20)
    expect(bounded.uiChanges).toMatchObject({ hidden: [], expanded: [], collapsed: [], changed: [] })
    const unsettled = toValue({ state: { ...value, settled: false } }, 16_000, { previousUrl: value.url, previousRevision: 1 })
    expect(unsettled.uiChanges).toBeUndefined()
    const emptyChanges = { shown: [], hidden: [], expanded: [], collapsed: [], changed: [] }
    expect(toValue({ state: { ...value, uiChanges: emptyChanges } }, 16_000,
      { previousUrl: value.url, previousRevision: 1 }).uiChanges).toBeUndefined()
    const focused = toValue({ state: { ...value, uiChanges: { ...emptyChanges, focused: '[1]<button>More</button>' } } },
      16_000, { previousUrl: value.url, previousRevision: 1 })
    expect(formatBrowserOutput(focused)).toContain('Focused:\n[1]<button>More</button>')
    expect(formatBrowserOutput({ ...focused, mode: 'diff' })).toContain('Focused:\n[1]<button>More</button>\n\nSnapshot revision: 2 → 2')
    const { action: _action, revision: _revision, ...legacy } = value
    expect(formatBrowserOutput({ ...legacy, response: 'result' })).toContain('Browser action completed.')
    expect(formatBrowserOutput({ ...legacy, mode: 'diff' })).toContain('Snapshot revision: 1 → 1\nAdded:\n\nChanged:\n\nRemoved:\n')
  })

  it('falls back to a full snapshot when the claimed revision is stale', () => {
    const value = toValue({
      action: { success: true, message: 'did click' },
      state: {
        url: 'https://shop.test/order', title: 'Order', header: 'Current Page: Order',
        content: '[1]<button>Save</button>\n[2]<p>Done</p>', footer: '[End of page]',
        tabs: [{ id: 1, url: 'https://shop.test/order', title: 'Order', status: 'complete', active: true }],
        tabId: 1, activeTabId: 1, settled: true, capturedAt: '2026-09-07T00:00:00.000Z',
      },
    }, 16_000, {
      compact: true, baseRevision: 1, previousUrl: 'https://shop.test/order', previousRevision: 3,
      previousElements: ['[1]<button>Save</button>'],
    })
    expect(value.mode).toBe('full')
    expect(value.content).toContain('[2]<p>Done</p>')
  })

  it('keeps a full snapshot when a stale claim sees unchanged content', () => {
    const value = toValue({
      action: { success: true, message: 'did wait' },
      state: {
        url: 'https://shop.test/order', title: 'Order', header: 'Current Page: Order',
        content: '[1]<button>Save</button>', footer: '[End of page]',
        tabs: [{ id: 1, url: 'https://shop.test/order', title: 'Order', status: 'complete', active: true }],
        tabId: 1, activeTabId: 1, settled: true, capturedAt: '2026-09-07T00:00:00.000Z',
      },
    }, 16_000, {
      compact: true, baseRevision: 1, previousUrl: 'https://shop.test/order', previousRevision: 3,
      previousContent: '[1]<button>Save</button>', previousElements: ['[1]<button>Save</button>'],
    })
    expect(value).toMatchObject({ mode: 'full', revision: 3, unchanged: false, content: '[1]<button>Save</button>' })
  })

  it('shortens headers that lack a viewport line and keeps the start-of-page hint', () => {
    expect(rankElementList('')).toBe('')
    expect(compactHeader('')).toBe('')
    expect(compactHeader('Just a title')).toBe('Just a title')
    expect(compactHeader([
      'Current Page: [Order](https://shop.test/order)',
      'Page info: unusual metrics',
      '[Start of page]',
    ].join('\n'))).toBe([
      'Current Page: [Order](https://shop.test/order)',
      'Page info: unusual metrics',
      '[Start of page]',
    ].join('\n'))
    expect(compactHeader([
      'Current Page: [Order](https://shop.test/order)',
      '... 80 pixels above - scroll up ...',
    ].join('\n'))).toContain('pixels above')
    const inactive = toValue({
      action: { success: true, message: 'did click' },
      state: {
        url: 'https://shop.test/help',
        title: 'Help',
        header: 'Current Page: [Help](https://shop.test/help)',
        content: '[0]<a>Home</a>',
        footer: 'Open confirm dialog: Continue?',
        tabs: [{ id: 2, url: 'https://shop.test/help', title: 'Help', status: 'complete', active: false }],
        tabId: 2,
        activeTabId: 1,
        settled: false,
        capturedAt: '2026-09-07T00:00:00.000Z',
      },
    }, 16_000, { compact: true, previousElements: ['[0]<a>Home</a>'], previousContent: '[0]<a>Home</a>', previousRevision: 1, previousUrl: 'https://shop.test/help' })
    const inactiveText = formatBrowserOutput(inactive)
    expect(inactiveText).toContain('Open confirm dialog: Continue?')
    expect(inactiveText).toContain('Tab [2] Help — https://shop.test/help')
    expect(inactiveText).not.toContain('(active)')
    expect(inactiveText).toContain('(background)')
    expect(inactiveText).toContain('transient evidence')
    const multi = toValue({
      action: { success: true, message: 'did click' },
      state: {
        url: 'https://shop.test/help',
        title: 'Help',
        header: 'Current Page: [Help](https://shop.test/help)\nPage info: 800x600px viewport, 1.5 pages above, 0.0 pages below',
        content: '[0]<a>Home</a>',
        footer: '... 100 pixels below ...',
        tabs: [
          { id: 1, url: 'https://shop.test/order', title: 'Order', status: 'complete', active: false },
          { id: 2, url: 'https://shop.test/help', title: 'Help', status: 'complete', active: true },
        ],
        tabId: 2,
        activeTabId: 2,
        settled: true,
        capturedAt: '2026-09-07T00:00:00.000Z',
      },
    }, 16_000, { compact: true })
    expect(formatBrowserOutput(multi)).toContain('Open tabs:')
    expect(multi.header).toContain('1.5 pages above')
    expect(multi.header).not.toContain('pages below')
  })
})


describe('selective browser output', () => {
  it('omits diagnostics snapshots, preserves targets, and resets unseen diff baselines', async () => {
    const { call, children } = await harness()
    try {
      await call('browser_state', {})
      const found = await call('browser_find', { regex: '/Order/i' })
      expect(text(found.content)).toContain('did find_element')
      expect(text(found.content)).not.toContain(PAGE)
      expect(found.meta).not.toHaveProperty('browser')
      const click = await call('browser_click', { target: 'e17' })
      expect(children[0]?.requests).toContainEqual({ method: 'click_element', args: { target: 'e17' } })
      expect(text(click.content)).toContain('id=submit')
      expect(text(click.content)).not.toContain('unchanged')
      await call('browser_snapshot', { target: '#form', depth: 2, boxes: true })
      expect(children[0]?.requests).toContainEqual({ method: 'get_browser_state', args: { waitForReady: true, snapshot: { target: '#form', depth: 2, boxes: true } } })
      await call('browser_tabs', { action: 'list' })
      expect(text((await call('browser_click', { target: '#submit' })).content)).toContain('id=submit')
      for (const args of [{ text: 'x', regex: 'x' }, { regex: '[' }, { text: '' }]) expect((await call('browser_find', args)).isError).toBe(true)
      expect((await call('browser_click', { target: '#submit', index: 1 })).isError).toBe(true)
      expect((await call('browser_snapshot', { depth: -1 })).isError).toBe(true)
    } finally { await call('browser_close', {}) }
  })

  it('requires explicit observation with snapshotMode none while retaining failure and readiness evidence', async () => {
    const { call, children } = await harness({ snapshotMode: 'none' })
    try {
      const action = text((await call('browser_click', { name: 'Order' })).content)
      expect(action).toContain('Snapshot omitted')
      expect(action).not.toContain('id=submit')
      expect(children[0]?.requests).toContainEqual({ method: 'get_browser_state', args: { metadataOnly: true, waitForReady: true } })
      expect(text((await call('browser_state', {})).content)).toContain('id=submit')
      expect(children[0]?.requests.at(-1)).toEqual({ method: 'get_browser_state', args: { waitForReady: true } })
      const value = toValue({ action: { success: false, message: 'Control unavailable' }, state: {
        url: 'https://test.invalid', title: 'Test', header: '', content: '', footer: 'Open confirm dialog: Continue?',
        tabs: [], tabId: 1, activeTabId: 1, settled: false, capturedAt: 'now',
      } }, 100)
      expect(formatBrowserOutput({ ...value, response: 'none' })).toMatch(/transient evidence[\s\S]*Action failed[\s\S]*Open confirm dialog/)
    } finally { await call('browser_close', {}) }
  })

  it('saves diagnostics and PNGs as private files for text-only models without image blocks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hydra-browser-output-test-'))
    const { call, children } = await harness({ outputDir: directory, imageResponses: 'omit' }, {}, { attachments: false, imageInput: false })
    try {
      for (const [tool, args, expected] of [
        ['browser_network_requests', { filter: '/api/i', filename: 'network.txt' }, 'did network_requests'],
        ['browser_network_request', { index: 3, part: 'response-body', filename: 'body.json' }, 'did network_request'],
        ['browser_snapshot', { filename: 'snapshot.txt' }, PAGE],
        ['browser_console_messages', { filename: 'console.txt' }, 'did console_messages'],
      ] as const) {
        const result = await call(tool, args)
        expect(result.isError).toBe(false)
        const value = result.value as unknown as ToolBrowser.BrowserToolValue
        expect(value.filename).toBeDefined()
        expect(await readFile(value.filename ?? '', 'utf8')).toBe(expected)
        expect(text(result.content)).not.toContain(expected)
      }
      expect(children[0]?.requests).toContainEqual({ method: 'console_messages', args: { level: 'error' } })
      expect(children[0]?.requests).toContainEqual({ method: 'network_requests', args: { includeStatic: false, filter: '/api/i' } })
      for (const args of [{ filename: 'evidence.png' }, {}]) {
        const result = await call('browser_screenshot', args)
        expect(result.isError).toBe(false)
        const value = result.value as unknown as ToolBrowser.BrowserScreenshotValue
        expect(await readFile(value.filename ?? '')).toEqual(PNG_1X1)
        expect(result.content.some(block => block.type === 'image')).toBe(false)
        expect(value.image.attachmentId).toBeUndefined()
      }
      const first = await saveBrowserArtifact(directory, 'same.txt', 'first', new AbortController().signal)
      const second = await saveBrowserArtifact(directory, 'same.txt', 'second', new AbortController().signal)
      expect(first).not.toBe(second)
      expect(await readFile(first, 'utf8')).toBe('first')
      const controller = new AbortController()
      controller.abort()
      await expect(saveBrowserArtifact(directory, 'aborted.txt', 'data', controller.signal)).rejects.toThrow()
      for (const filename of ['../escape.txt', 'C:\\escape.txt', 'CON.txt', 'trailing.', '']) {
        expect((await call('browser_snapshot', { filename })).isError).toBe(true)
      }
    } finally { await call('browser_close', {}); await rm(directory, { recursive: true, force: true }) }
  })
})
