import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import AgentRegistry, { Inbox, agentEvents } from '@hydraharness/harness-agent'
import type { Agent } from '@hydraharness/harness-agent'
import type { BrowserAction, BrowserPageIdentity } from '@hydraharness/harness-browser-electron'
import { BrowserError } from '@hydraharness/harness-browser-electron'
import { CallId, createToolResultMessage, createUserMessage, markAgentLoopRequest, type GenerateOptions } from '@hydraharness/harness-llm'
import SessionStore, { Session, SessionId } from '@hydraharness/harness-session'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import ToolRuntime from '@hydraharness/harness-tools'
import SettingsProvider from '@hydraharness/harness-settings'
import * as ToolBrowser from '@hydraharness/harness-tool-browser'
import * as PageMemory from '../src/index.ts'
import { PageMemoryStore, pageKey } from '../src/store.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })

class TestSettings extends SettingsProvider {
  readonly writable = true
  protected load() { return Promise.resolve({}) }
  protected persist() { return Promise.resolve() }
}

const workflow = {
  task: 'save_form', summary: 'Save the form.',
  accountHint: 'Use a staff account with order-management access.',
  anchors: [{ target: '#title', text: 'Orders' }],
  locators: { search: '#search' },
  steps: ['Fill the search field with the requested value.', 'Save the form.'],
  successCheck: { target: '#status', text: 'Saved' },
  pitfalls: ['Read dynamic order values from the live page.'],
}

async function harness(config: Partial<PageMemory.Config> = {}, direct = false, withSettings = false, experimentalScriptExecution = false) {
  const workspace = await mkdtemp(join(tmpdir(), 'hydra-page-memory-test-'))
  cleanup.push(() => rm(workspace, { recursive: true, force: true }))
  const root = new Context().plugin(() => {})
  const ctx = root.ctx
  cleanup.push(() => root.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (withSettings) await ctx.plugin(TestSettings).await()
  let page: BrowserPageIdentity | undefined = {
    url: 'https://shop.test/orders?tab=open#list', title: 'Orders', tabId: 1, activeTabId: 1, settled: true,
  }
  const regions = new Map([['#title', '- heading "Orders"'], ['#search', '- textbox "Search"'], ['#status', '- status: Pending']])
  const reads: string[] = []
  let explicitReadsOnly = false
  let beforeSnapshot: (() => Promise<void>) | undefined
  const browser = {
    experimentalScriptExecution, fullCdpAccess: false,
    currentPage: (_agent: Agent, execution: { callId?: string } = {}) => {
      if (explicitReadsOnly && execution.callId === undefined) throw new BrowserError('Approval requires an explicit call', 'BROWSER_POLICY_DENIED')
      return Promise.resolve(page === undefined ? undefined : { ...page })
    },
    async perform(_agent: Agent, action: BrowserAction) {
      if (page === undefined) throw new Error('No page')
      if (action.method === 'navigate') page.url = action.url
      if (action.method === 'click_element') regions.set('#status', '- status: Saved')
      let content = [...regions.values()].join('\n')
      if (action.method === 'get_browser_state' && action.snapshot?.target !== undefined) {
        const callback = beforeSnapshot
        beforeSnapshot = undefined
        await callback?.()
        reads.push(action.snapshot.target)
        const region = regions.get(action.snapshot.target)
        if (region === undefined) throw new Error('Locator did not match exactly one element')
        content = region
      }
      const state = {
        ...page, content, header: '', footer: '', capturedAt: '2026-09-13T00:00:00.000Z',
        tabs: [{ id: page.tabId, url: page.url, title: page.title, active: true, status: 'complete' as const }],
      }
      return action.method === 'get_browser_state' ? { state } : { state, action: { success: true, message: 'Action completed' } }
    },
    close: () => { page = undefined; return Promise.resolve(true) },
  }
  ctx.reflect.provide('browsers', browser)
  await ctx.plugin(ToolBrowser)
  const options = { workspaceDir: workspace, storageDir: join(workspace, 'memory'), role: 'operator', locale: 'en-US', ...config }
  const fiber = direct ? ctx.plugin({ name: PageMemory.name, inject: PageMemory.inject, apply: ctx => PageMemory.apply(ctx, options) })
    : ctx.plugin(PageMemory, options)
  await fiber
  const id = SessionId('page-memory-test')
  const session = Session.create(id, undefined, { id, version: 0, createdAt: 0, cwd: workspace })
  const detach = ctx.get('sessions')!.enter(session)
  ctx.get('sessions')!.announce(session)
  cleanup.push(async () => { detach() })
  session.append('turn/start', { turn: 1 })
  const agent: Agent = {
    id, options: {}, session, ctx: ctx.plugin(() => {}).ctx, status: 'idle',
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    send() {}, followup() {}, inject() {}, cancel() {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' }) }),
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  const unregister = ctx.get('agents')!.register(agent)
  let callIndex = 0
  const call = (name: string, args: Record<string, unknown> = {}) => ctx.get('tools')!.execute({
    signal: new AbortController().signal, callId: CallId(`call-${++callIndex}`), name, arguments: args, agent,
  })
  function request(messages = session.deriveMessages(), loop = true) {
    const options: GenerateOptions = { provider: 'test', model: 'test', sessionId: id, messages }
    if (loop) markAgentLoopRequest(options)
    void ctx.waterfall('llm/stream', options as never, () => (async function* () {})() as never)
  }
  async function admit(dispatch = true) {
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: callIndex + 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    if (decision.kind === 'enter') {
      for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
      if (dispatch) request()
      return decision.messages
    }
    return []
  }
  return {
    ctx, fiber, agent, session, workspace, options, reads, regions, browser, call, admit, request, detach, unregister,
    requireExplicitReads: () => { explicitReadsOnly = true },
    beforeNextSnapshot: (callback: () => Promise<void>) => { beforeSnapshot = callback },
    page: () => page!, setPage: (next: BrowserPageIdentity | undefined) => { page = next },
  }
}

function context(result: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['call']>>) {
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

describe('verified page-memory integration', () => {
  it('uses direct defaults and validates persisted settings before accepting them', async () => {
    const h = await harness({}, true, true)
    const settings = h.ctx.get('settings')!
    const namespace = PageMemory.PAGE_MEMORY_SETTINGS_NAMESPACE
    for (const value of [{ role: ' ' }, { locale: 'x'.repeat(129) }, { storageDir: 'relative' }]) {
      await expect(settings.update(namespace, value)).rejects.toThrow()
    }
    const beforeInvalidNumbers = settings.get(namespace)
    for (const value of [{ maxPages: Number.MAX_SAFE_INTEGER + 1 }, { verificationTimeoutMs: 2_147_483_648 }]) {
      await expect(settings.update(namespace, value)).rejects.toThrow()
      expect(settings.get(namespace)).toEqual(beforeInvalidNumbers)
    }
    await expect(settings.update(namespace, { role: 'operator', locale: 'en-US' }))
      .resolves.toBeUndefined()
    expect(context(await h.call('page_memory_get'))).toContain('select-task')
  })

  it('rejects numeric overflow at the config and settings schema boundary', () => {
    expect(() => PageMemory.Config({ workspaceDir: '/workspace', role: 'operator', locale: 'en-US', maxPages: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow()
    expect(() => PageMemory.Config({ workspaceDir: '/workspace', role: 'operator', locale: 'en-US', verificationTimeoutMs: 2_147_483_648 }))
      .toThrow()
    expect(() => PageMemory.PageMemorySettingsSchema({ maxPages: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow()
    expect(() => PageMemory.PageMemorySettingsSchema({ verificationTimeoutMs: 2_147_483_648 }))
      .toThrow()
  })

  it('uses the configured Hydra home and allows reads before the first turn', async () => {
    const h = await harness()
    await h.fiber.dispose()
    vi.stubEnv('HYDRA_HOME', join(h.workspace, 'home'))
    const { storageDir: _storageDir, ...options } = h.options
    await h.ctx.plugin({ name: PageMemory.name, inject: PageMemory.inject, apply: ctx => PageMemory.apply(ctx, options) }).await()
    const id = SessionId('before-turn')
    const session = Session.create(id, undefined, { id, version: 0, createdAt: 0, cwd: h.workspace })
    const result = await h.ctx.get('tools')!.execute({ name: 'page_memory_get', arguments: {}, callId: CallId('initial'),
      signal: new AbortController().signal, agent: { ...h.agent, session } })
    expect(context(result)).toContain('select-task')
    expect(await readdir(join(h.workspace, 'home', 'page-memory'))).toHaveLength(1)
  })

  it('does not inject or guard another workspace and rejects foreign saves', async () => {
    const h = await harness()
    const id = SessionId('foreign')
    const session = Session.create(id, undefined, { id, version: 0, createdAt: 0 })
    const agent = { ...h.agent, session }
    const decision = await agentEvents(h.ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    const execution = { name: 'browser_click', arguments: { target: '#save' }, callId: CallId('foreign'),
      signal: new AbortController().signal, agent }
    expect((await h.ctx.get('tools')!.execute(execution)).isError).toBe(false)
    expect((await h.ctx.get('tools')!.execute({ ...execution, name: 'page_memory_upsert', arguments: workflow })).isError).toBe(true)
    expect((await h.ctx.get('tools')!.execute({ name: 'page_memory_upsert', arguments: workflow,
      callId: CallId('no-agent'), signal: new AbortController().signal })).isError).toBe(true)
  })

  it('preserves downstream rejection and cancellation before automatic recall', async () => {
    const h = await harness()
    const execution = { messages: [], turn: 1, step: 1, signal: new AbortController().signal }
    const rejected = await agentEvents(h.ctx, h.agent).waterfall('agent/pre-step', execution,
      () => Promise.resolve({ kind: 'reject' }))
    expect(rejected).toEqual({ kind: 'reject' })
    const aborted = await agentEvents(h.ctx, h.agent).waterfall('agent/pre-step', { ...execution, signal: AbortSignal.abort() },
      () => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(aborted).toEqual({ kind: 'enter', messages: [] })
  })

  it('presents both memory tools and ignores failed or unrelated explicit recall records', async () => {
    const h = await harness()
    expect(h.ctx.get('tools')!.get('page_memory_get')?.presentCall?.({})).toMatchObject({ title: 'Read page memory' })
    expect(h.ctx.get('tools')!.get('page_memory_upsert')?.presentCall?.(workflow)).toMatchObject({ title: 'Save verified page memory' })
    h.requireExplicitReads()
    h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' })
    for (const [name, isError] of [['echo', false], ['page_memory_get', true]] as const) {
      const callId = CallId(name)
      const seq = h.session.events.length
      h.session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
      h.session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId, isError, content: [{ type: 'text', text: 'unusable' }] }),
      }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
    }
    expect(JSON.stringify(await h.admit())).toContain('unavailable')
  })

  it('clears action evidence after a failed browser action and ignores close results without page state', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    const perform = h.browser.perform.bind(h.browser)
    vi.spyOn(h.browser, 'perform').mockImplementation(async (agent, action) => {
      const result = await perform(agent, action)
      return { ...result, action: { success: false, message: 'Action refused' } }
    })
    await h.call('browser_click', { target: '#save' })
    expect((await h.call('page_memory_upsert', workflow)).isError).toBe(true)
    await h.call('browser_close')
    expect(h.page()).toBeUndefined()
  })

  it.each([
    ['browser_click_at', { x: 10, y: 10 }],
    ['browser_execute_javascript', { script: 'document.body.dataset.memory = "saved"' }],
    ['browser_page_agent_run', { task: 'save the form' }],
  ] as Array<[string, Record<string, unknown>]>)('accepts %s as successful save evidence', async (name, args) => {
    const h = await harness({}, false, false, true)
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    h.regions.set('#status', '- status: Saved')
    expect((await h.call(name, args)).isError).toBe(false)
    expect((await h.call('page_memory_upsert', workflow)).isError).toBe(false)
  })


  it.each([
    { workspaceDir: 'relative' }, { role: '' }, { locale: 'x'.repeat(129) }, { maxPages: 0 },
    { maxContextBytes: 255 }, { maxPages: Number.MAX_SAFE_INTEGER + 1 },
    { verificationTimeoutMs: 2_147_483_648 }, { storageDir: 'relative' },
  ])('rejects invalid direct configuration %j', async (config) => {
    await expect(harness(config, true)).rejects.toThrow()
  })

  it('rejects a direct verification timeout above the AbortSignal limit', async () => {
    await expect(harness({ verificationTimeoutMs: 2_147_483_648 }, true))
      .rejects.toThrow('verificationTimeoutMs must be at most 2147483647')
  })

  it('keeps background recall and storage dormant until a controlled page exists', async () => {
    const h = await harness()
    const page = h.page()
    h.setPage(undefined)
    const perform = vi.spyOn(h.browser, 'perform')
    expect(await h.admit()).toEqual([])
    expect(perform).not.toHaveBeenCalled()
    await expect(readdir(join(h.workspace, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' })

    h.setPage(page)
    expect(JSON.stringify(await h.admit())).toContain('select-task')
    expect(await h.admit()).toEqual([])
    h.setPage(undefined)
    expect(JSON.stringify(await h.admit())).toContain('inactive')
    expect(await h.admit()).toEqual([])
  })

  it('returns inactive without a page and lists stored tasks in a fresh turn', async () => {
    const h = await harness()
    const page = h.page()
    h.setPage(undefined)
    expect(await h.admit()).toEqual([])
    expect(context(await h.call('page_memory_get'))).toContain('inactive')
    h.setPage(page)
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    for (const task of [' ', 'x'.repeat(129)]) expect((await h.call('page_memory_get', { task })).isError).toBe(true)
    await h.call('page_memory_get', { task: workflow.task })
    await h.admit()
    await h.call('browser_click', { target: '#save', tab_id: 1 })
    context(await h.call('page_memory_upsert', workflow))
    h.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    h.session.append('turn/start', { turn: 2 })
    expect(context(await h.call('page_memory_get'))).toContain(workflow.task)
    expect(context(await h.call('page_memory_get', { task: workflow.task }))).toContain('verified')
    h.page().settled = false
    expect(context(await h.call('page_memory_get'))).toContain('loading')
  })

  it('omits query and fragment values from model-visible recall', async () => {
    const h = await harness()
    h.page().url = 'https://shop.test/callback?state=opaque-secret#view'
    const text = context(await h.call('page_memory_get', { task: workflow.task }))
    expect(text).toContain('https://shop.test/callback')
    expect(text).not.toContain('opaque-secret')
    expect(text).not.toContain('#view')
  })

  it('redacts an invalid page URL in model-visible recall', async () => {
    const h = await harness()
    h.page().url = 'not-a-url'
    const result = await h.call('page_memory_get', { task: workflow.task })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: page-memory: URL is invalid' }])
  })

  it.each(['url', 'tab', 'settled', 'final-page', 'action'] as const)('rejects changed %s during workflow verification', async (kind) => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task })
    await h.admit()
    await h.call('browser_click', { target: '#save' })
    h.beforeNextSnapshot(async () => {
      if (kind === 'url') h.page().url = 'https://shop.test/changed'
      if (kind === 'tab') h.page().tabId = 2
      if (kind === 'settled') h.page().settled = false
      if (kind === 'final-page') vi.spyOn(h.browser, 'currentPage').mockResolvedValue(undefined)
      if (kind === 'action') await h.call('page_memory_get', { task: 'different' })
    })
    const result = await h.call('page_memory_upsert', workflow)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/Page changed|action evidence changed/)
  })

  it('evicts old source observations and rejects mismatched source text', async () => {
    const h = await harness({ maxObservations: 1 })
    const sourceUrl = h.page().url
    await h.call('page_memory_get', { task: workflow.task })
    await h.admit()
    await h.call('browser_snapshot', { target: '#title' })
    await h.call('browser_snapshot', { target: '#search' })
    h.page().url = 'https://shop.test/done'
    await h.admit()
    await h.call('browser_click', { target: '#save' })
    expect((await h.call('page_memory_upsert', { ...workflow, sourceUrl })).isError).toBe(true)
  })

  it('keeps stale workflows hidden on subsequent recalls and reports unexpected browser errors', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    await h.call('browser_click', { target: '#save' }); await h.call('page_memory_upsert', workflow)
    h.regions.set('#title', '')
    const stale = context(await h.call('page_memory_get'))
    expect(stale).toContain('No visible content at #title')
    expect(context(await h.call('page_memory_get'))).toBe(stale)
    await h.fiber.dispose()
    await h.ctx.plugin(PageMemory, h.options)
    expect(context(await h.call('page_memory_get', { task: workflow.task }))).toBe(stale)
    vi.spyOn(h.browser, 'currentPage').mockRejectedValue(new Error('disconnected'))
    expect(JSON.stringify(await h.admit())).toContain('unavailable')
  })

  it('rechecks saved locators before returning workflow instructions', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    await h.call('browser_click', { target: '#save' }); await h.call('page_memory_upsert', workflow)
    h.regions.delete('#search')
    expect(context(await h.call('page_memory_get'))).toContain('"status":"unavailable"')
    expect(h.reads.at(-1)).toBe('#search')
    h.regions.set('#search', '- textbox "Search"')
    expect(context(await h.call('page_memory_get'))).toContain('"status":"verified"')
  })

  it('rejects partial anchor text matches during live verification', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    await h.call('browser_click', { target: '#save' }); await h.call('page_memory_upsert', workflow)
    h.regions.set('#title', '- heading "ArchivedOrders"')
    const stale = context(await h.call('page_memory_get'))
    expect(stale).toContain('"status":"stale"')
    expect(stale).toContain('Expected text did not match at #title')
    expect(context(await h.call('page_memory_get'))).toBe(stale)
  })

  it('reads each selector once per verification pass and checks every expectation', async () => {
    const h = await harness()
    const repeated = {
      ...workflow,
      anchors: [{ target: '#title', text: 'Orders' }, { target: '#title', text: 'heading' }, { target: '#search', text: 'Search' }],
      locators: { title: '#title', search: '#search', status: '#status' },
    }
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    context(await h.call('browser_click', { target: '#save' }))
    h.reads.length = 0
    context(await h.call('page_memory_upsert', repeated))
    expect(h.reads).toEqual(['#title', '#search', '#status'])
    h.reads.length = 0
    expect(context(await h.call('page_memory_get'))).toContain('"status":"verified"')
    expect(h.reads).toEqual(['#title', '#search', '#status'])
    h.reads.length = 0
    expect(context(await h.call('page_memory_get'))).toContain('"status":"verified"')
    expect(h.reads).toEqual(['#title', '#search', '#status'])
    h.regions.set('#title', '- button "Orders"')
    h.reads.length = 0
    expect(context(await h.call('page_memory_get'))).toContain('"status":"stale"')
    expect(h.reads).toEqual(['#title'])
  })

  it('omits host metadata from guidance and republishes only procedure changes', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    context(await h.call('browser_click', { target: '#save' }))
    context(await h.call('page_memory_upsert', workflow))
    await h.admit()
    const initial = context(await h.call('page_memory_get'))
    expect(initial).not.toMatch(/revision|lastVerifiedAt/)
    context(await h.call('browser_click', { target: '#save' }))
    context(await h.call('page_memory_upsert', workflow))
    expect(context(await h.call('page_memory_get'))).toBe(initial)
    expect(await h.admit()).toEqual([])
    context(await h.call('browser_click', { target: '#save' }))
    context(await h.call('page_memory_upsert', { ...workflow, steps: ['Read the current form.', ...workflow.steps] }))
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    expect(JSON.stringify(await h.admit())).toContain('Read the current form.')
    context(await h.call('browser_click', { target: '#save' }))
  })

  it('requires guidance in a model request before allowing actions, and reinjects after compaction', async () => {
    const h = await harness()
    const result = await h.call('page_memory_get', { task: workflow.task })
    context(result)
    const callId = CallId('explicit-read')
    const seq = h.session.events.length
    h.session.append('tool/call', { turn: 1, step: 1, callId, name: 'page_memory_get', arguments: '{}' })
    h.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: result.content, isError: false }) },
      { surfaceOp: 'append', sourceEventSeqs: [seq] })
    expect(await h.admit(false)).toEqual([])
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    h.request([])
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    h.request(h.session.deriveMessages(), false)
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    void h.ctx.waterfall('llm/stream', { provider: 'test', model: 'test', messages: h.session.deriveMessages() } as never,
      () => (async function* () {})() as never)
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    h.request()
    context(await h.call('browser_click', { target: '#save' }))
    const nodes = [...h.session.surface.nodes]
    h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Compacted summary.' }], source: { kind: 'plugin', plugin: 'compaction' } }),
      { surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: nodes })
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    expect(JSON.stringify(await h.admit())).toContain('missing')
    context(await h.call('browser_click', { target: '#save' }))
  })

  it('requires the requested message to survive a partial rewrite even when identical guidance remains', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task })
    const [first] = await h.admit()
    const firstSeq = h.session.surface.nodes.at(-1)!
    h.session.append('user/message', createUserMessage({ content: first!.content, source: { kind: 'plugin', plugin: PageMemory.name } }),
      { surfaceOp: 'append' })
    context(await h.call('browser_click', { target: '#save' }))
    h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Task summary.' }], source: { kind: 'plugin', plugin: 'compaction' } }),
      { surfaceOp: { op: 'replace', start: firstSeq, end: firstSeq }, sourceEventSeqs: [firstSeq] })
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    expect(await h.admit()).toEqual([])
    context(await h.call('browser_click', { target: '#save' }))
  })

  it.each([false, true])('clears disposed Session state with an already unregistered agent=%s', async (unregistered) => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    context(await h.call('browser_click', { target: '#save' }))
    if (unregistered) h.unregister()
    h.detach()
    const denied = await h.call('browser_click', { target: '#save' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('Choose a stable task')
    const session = Session.create(h.agent.id, undefined, h.session.header)
    const detach = h.ctx.get('sessions')!.enter(session)
    h.ctx.get('sessions')!.announce(session)
    cleanup.push(async () => { detach() })
    session.append('turn/start', { turn: 1 })
    const agent = { ...h.agent, session }
    context(await h.ctx.get('tools')!.execute({ name: 'page_memory_get', arguments: { task: workflow.task },
      signal: new AbortController().signal, callId: CallId('new-session-read'), agent }))
    const decision = await agentEvents(h.ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(JSON.stringify(decision)).toContain('missing')
    detach()
  })

  it('restores saved guidance from disk without treating a resumed log as a model request', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    context(await h.call('browser_click', { target: '#save' }))
    context(await h.call('page_memory_upsert', workflow)); await h.admit()
    const path = join(h.workspace, 'session.json')
    await writeFile(path, JSON.stringify({ events: h.session.events, header: h.session.header }))
    h.detach(); h.unregister()
    const saved = JSON.parse(await readFile(path, 'utf8')) as { events: typeof h.session.events; header: typeof h.session.header }
    const session = Session.fromRestore(saved.header.id, saved.events, saved.header)
    const detach = h.ctx.get('sessions')!.enter(session)
    h.ctx.get('sessions')!.announce(session)
    const agent = { ...h.agent, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }) }
    const unregister = h.ctx.get('agents')!.register(agent)
    cleanup.push(async () => { unregister(); detach() })
    const call = (name: string, args: Record<string, unknown>) => h.ctx.get('tools')!.execute({ name, arguments: args,
      agent, callId: CallId(`resumed-${name}`), signal: new AbortController().signal })
    expect(context(await call('page_memory_get', { task: workflow.task }))).toContain('"status":"verified"')
    expect((await call('browser_click', { target: '#save' })).isError).toBe(true)
    const decision = await agentEvents(h.ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    const options: GenerateOptions = { provider: 'test', model: 'test', sessionId: session.id, messages: session.deriveMessages() }
    markAgentLoopRequest(options)
    void h.ctx.waterfall('llm/stream', options as never, () => (async function* () {})() as never)
    context(await call('browser_click', { target: '#save' }))
  })

  it('keeps combining marks attached to anchor words during live verification', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    await h.call('browser_click', { target: '#save' }); await h.call('page_memory_upsert', workflow)
    h.regions.set('#title', '- heading "Orders\u0301archive"')
    expect(context(await h.call('page_memory_get'))).toContain('"status":"stale"')
  })

  it('does not publish or invalidate an old workflow when another writer replaces it during verification', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task })
    await h.admit()
    context(await h.call('browser_click', { target: '#save' }))
    context(await h.call('page_memory_upsert', workflow))
    const scopes = await readdir(join(h.workspace, 'memory'))
    const store = new PageMemoryStore(join(h.workspace, 'memory', scopes[0]!), { maxRecordBytes: 32768, maxWorkflows: 12, maxPages: 500, maxHistory: 256 })
    cleanup.push(() => store.close())
    const key = pageKey(h.page().url, { workspace: await realpath(h.workspace), role: 'operator', locale: 'en-US' }, [])
    h.regions.set('#title', 'Changed old anchor')
    h.beforeNextSnapshot(async () => { await store.upsert(key, { ...workflow, summary: 'Replacement instructions.', anchors: [{ target: '#status', text: 'Saved' }] }) })
    const result = context(await h.call('page_memory_get'))
    expect(result).toContain('"status":"changed"')
    expect(result).not.toContain('Save the form.')
    expect(await store.read(key)).toEqual([expect.objectContaining({ status: 'verified', summary: 'Replacement instructions.' })])
    expect((await store.history(key)).some(trace => trace.outcome === 'stale')).toBe(false)
    expect(context(await h.call('page_memory_get'))).toContain('Replacement instructions.')
  })

  it('verifies a workflow, persists SQLite, recalls only its task, and logs each changed context once', async () => {
    const h = await harness()
    expect(context(await h.call('page_memory_get', { task: workflow.task }))).toContain('"status":"missing"')
    await h.admit()
    expect((await h.call('page_memory_upsert', workflow)).isError).toBe(true)
    context(await h.call('browser_click', { target: '#save' }))
    expect(context(await h.call('page_memory_upsert', workflow))).toContain('Page memory verified: save_form')
    expect(h.reads).toEqual(expect.arrayContaining(['#title', '#search', '#status']))
    const entered = await h.admit()
    expect(JSON.stringify(entered)).toContain('Fill the search field')
    expect(await h.admit()).toEqual([])
    const scopes = await readdir(join(h.workspace, 'memory'))
    expect(await readdir(join(h.workspace, 'memory', scopes[0]!))).toEqual(expect.arrayContaining(['page-memory.sqlite']))
    expect(context(await h.call('page_memory_get', { task: 'another_task' }))).not.toContain('Fill the search field')
    await h.fiber.dispose()
    expect(h.ctx.get('tools')!.schemas().some(tool => tool.name === 'page_memory_get')).toBe(false)
    await h.ctx.plugin(PageMemory, h.options)
    expect(context(await h.call('page_memory_get', { task: workflow.task }))).toContain('"status":"verified"')
    expect(context(await h.call('page_memory_get'))).toContain(workflow.accountHint)
  })

  it('rechecks manual tab/SPA changes, separates query routes, and hides stale instructions', async () => {
    const h = await harness({ routes: [{ origin: 'https://shop.test', path: '/orders/:id' }] })
    await h.call('page_memory_get', { task: workflow.task })
    await h.admit()
    await h.call('browser_click', { target: '#save' })
    context(await h.call('page_memory_upsert', workflow))
    await h.admit()
    h.setPage({ ...h.page(), url: 'https://shop.test/orders?tab=payments#list', tabId: 2, activeTabId: 2 })
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    const changedPage = JSON.stringify(await h.admit())
    expect(changedPage).toContain('https://shop.test/orders')
    expect(changedPage).not.toContain('payments')
    expect(context(await h.call('page_memory_get'))).toContain('"status":"missing"')
    h.setPage({ ...h.page(), url: 'https://shop.test/orders?tab=open#list', tabId: 1, activeTabId: 1 })
    h.regions.set('#title', '- heading "Invoices"')
    const stale = context(await h.call('page_memory_get'))
    expect(stale).toContain('"status":"stale"')
    expect(stale).not.toContain('Fill the search field')
    h.setPage(undefined)
    expect(context(await h.call('page_memory_get'))).toContain('"status":"inactive"')
  })

  it('requires observed same-tab source anchors when saving a workflow ending on another route', async () => {
    const h = await harness()
    const sourceUrl = h.page().url
    await h.call('page_memory_get', { task: workflow.task })
    await h.admit()
    context(await h.call('browser_snapshot', { target: '#title', depth: 1 }))
    context(await h.call('browser_snapshot', { target: '#search', depth: 1 }))
    h.page().url = 'https://shop.test/saved'
    await h.admit()
    context(await h.call('browser_click', { target: '#save' }))
    expect((await h.call('page_memory_upsert', { ...workflow, sourceUrl: 'https://other.test/orders' })).isError).toBe(true)
    context(await h.call('page_memory_upsert', { ...workflow, sourceUrl }))
    h.page().url = sourceUrl
    expect(context(await h.call('page_memory_get', { task: workflow.task }))).toContain('"status":"verified"')
  })

  it('rejects partial source anchor text before saving a cross-route workflow', async () => {
    const h = await harness()
    const sourceUrl = h.page().url
    await h.call('page_memory_get', { task: workflow.task }); await h.admit()
    h.regions.set('#title', '- heading "ArchivedOrders"')
    context(await h.call('browser_snapshot', { target: '#title', depth: 1 }))
    context(await h.call('browser_snapshot', { target: '#search', depth: 1 }))
    h.page().url = 'https://shop.test/saved'; await h.admit()
    context(await h.call('browser_click', { target: '#save' }))
    expect((await h.call('page_memory_upsert', { ...workflow, sourceUrl })).isError).toBe(true)
  })

  it('rejects unverified success, transient refs, foreign workspaces, and oversized whole messages', async () => {
    const h = await harness({ maxContextBytes: 256 })
    await h.call('page_memory_get', { task: workflow.task })
    await h.admit()
    await h.call('browser_click', { target: '#save' })
    h.regions.set('#status', '- status: Pending')
    expect((await h.call('page_memory_upsert', workflow)).isError).toBe(true)
    h.regions.set('#status', '- status: Saved')
    expect((await h.call('page_memory_upsert', { ...workflow, locators: { save: 'e17' } })).isError).toBe(true)
    expect((await h.call('page_memory_upsert', workflow)).isError).toBe(true)
    expect(Buffer.byteLength(context(await h.call('page_memory_get', { task: 'a'.repeat(128) })))).toBeLessThanOrEqual(256)
    const foreign = Session.create(SessionId('foreign'), undefined, { id: SessionId('foreign'), version: 0, createdAt: 0, cwd: tmpdir() })
    const result = await h.ctx.get('tools')!.execute({ name: 'page_memory_get', arguments: {}, callId: CallId('foreign'), signal: new AbortController().signal, agent: { ...h.agent, session: foreign } })
    expect(result.isError).toBe(true)
  })

  it('reinjects guidance removed by compaction and preserves verified records after a transient read failure', async () => {
    const h = await harness()
    await h.call('page_memory_get', { task: workflow.task })
    await h.admit()
    await h.call('browser_click', { target: '#save' })
    context(await h.call('page_memory_upsert', workflow))
    await h.admit()
    const replaced = [...h.session.surface.nodes]
    h.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Compacted task summary.' }], source: { kind: 'plugin', plugin: 'test-compaction' },
    }), { surfaceOp: { op: 'replace', start: replaced[0]!, end: replaced.at(-1)! }, sourceEventSeqs: replaced })
    expect(JSON.stringify(await h.admit())).toContain('Fill the search field')
    h.regions.delete('#title')
    expect(context(await h.call('page_memory_get'))).toContain('"status":"unavailable"')
    h.regions.set('#title', '- heading "Orders"')
    expect(context(await h.call('page_memory_get'))).toContain('"status":"verified"')
  })

  it('binds successful action evidence to the selected task and requires source observations before that action', async () => {
    const h = await harness()
    const sourceUrl = h.page().url
    await h.call('page_memory_get', { task: workflow.task })
    await h.admit()
    context(await h.call('browser_click', { target: '#save' }))
    expect((await h.call('page_memory_upsert', { ...workflow, task: 'different_task' })).isError).toBe(true)
    h.page().url = 'https://shop.test/saved'
    await h.admit()
    context(await h.call('browser_click', { target: '#save' }))
    h.page().url = sourceUrl
    context(await h.call('browser_snapshot', { target: '#title' }))
    context(await h.call('browser_snapshot', { target: '#search' }))
    h.page().url = 'https://shop.test/saved'
    expect((await h.call('page_memory_upsert', { ...workflow, sourceUrl })).isError).toBe(true)
  })

  it('uses a logged explicit read when background browsing requires approval, and still rechecks page changes', async () => {
    const h = await harness()
    h.requireExplicitReads()
    expect(JSON.stringify(await h.admit())).toContain('unavailable')
    const result = await h.call('page_memory_get', { task: workflow.task })
    context(result)
    const callId = CallId('approved-read')
    const callSeq = h.session.events.length
    h.session.append('tool/call', { turn: 1, step: 1, callId, name: 'page_memory_get', arguments: JSON.stringify({ task: workflow.task }) })
    h.session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId, content: result.content, isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
    expect(await h.admit()).toEqual([])
    context(await h.call('browser_click', { target: '#save' }))
    h.page().url = 'https://shop.test/other'
    expect((await h.call('browser_click', { target: '#save' })).isError).toBe(true)
  })
})
