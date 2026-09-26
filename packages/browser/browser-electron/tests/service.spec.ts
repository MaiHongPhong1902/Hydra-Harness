import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra1902/cordis'
import { CallId, createToolResultMessage, createUserMessage } from '@hydra1902/harness-llm'
import AgentRegistry, { Inbox } from '@hydra1902/harness-agent'
import type { Agent } from '@hydra1902/harness-agent'
import { Session, SessionId } from '@hydra1902/harness-session'
import { SettingsProvider } from '@hydra1902/harness-settings'
import type { SettingsNamespace } from '@hydra1902/harness-settings'
import ApprovalService from '@hydra1902/harness-user-approval'
import UserQuestionService from '@hydra1902/harness-user-questions'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '@hydra1902/harness-llm'
import type { ApprovalOutcome, ApprovalRequest } from '@hydra1902/harness-user-approval'
import BrowserSessionService, { BROWSER_SETTINGS_NAMESPACE } from '@hydra1902/harness-browser-electron'
import type { BrowserChildProcess, Config } from '@hydra1902/harness-browser-electron'

const agentScopeDisposers = new WeakMap<Agent, () => Promise<void>>()
const UPLOAD_FIXTURE = fileURLToPath(new URL('./fixtures/form.html', import.meta.url))
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

function screenshot(label: string): Record<string, unknown> {
  return {
    mediaType: 'image/png',
    data: PNG_1X1.toString('base64'),
    bytes: PNG_1X1.length,
    width: 1,
    height: 1,
    tabId: 1,
    mode: 'viewport',
    url: `https://${label}.test`,
    title: label,
    capturedAt: '2026-08-27T00:00:00.000Z',
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

function stubAgent(ctx: Context, rawId: string): Agent {
  const id = SessionId(rawId)
  const scopeFiber = ctx.plugin(() => {})
  const session = Session.create(id)
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  agentScopeDisposers.set(agent, async () => { await scopeFiber.dispose() })
  return agent
}

async function disposeAgentScope(agent: Agent): Promise<void> {
  const dispose = agentScopeDisposers.get(agent)
  if (dispose === undefined) throw new Error('missing agent scope')
  await dispose()
}

function cdpEventPage(label: string, args: Record<string, unknown>) {
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
      params: { requestId: label },
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
 * A child that answers every request the way the Electron main process would:
 * `{success, message}` for actions, a state object for `get_browser_state`.
 */
class ScriptedChild extends EventEmitter implements BrowserChildProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: { method: string; args: Record<string, unknown> }[] = []
  readonly responses = new Map<string, unknown>()
  killed = false

  /** Method names in arrival order. */
  get seen(): string[] {
    return this.requests.map(request => request.method)
  }

  constructor(
    readonly label: string,
    beforeReply: (method: string, args: Record<string, unknown>) => Promise<void> = () => Promise.resolve(),
    readonly screenshotResult: unknown = screenshot(label),
    ready = true,
  ) {
    super()
    createInterface({ input: this.stdin }).on('line', (line: string) => {
      const { id, method, args } = JSON.parse(line) as { id: number; method: string; args: Record<string, unknown> }
      this.requests.push({ method, args })
      const result = this.responses.has(method) ? this.responses.get(method) : method === 'get_browser_state'
        ? {
          url: `https://${label}.test`,
          title: label,
          header: 'h',
          content: 'c',
          footer: 'f',
          tabs: [{ id: 1, url: `https://${label}.test`, title: label, status: 'complete', active: true }],
          tabId: typeof args.tabId === 'number' ? args.tabId : 1,
          activeTabId: 1,
          settled: true,
          capturedAt: '2026-08-24T00:00:00.000Z',
        }
        : method === 'get_page_identity'
          ? {
            url: `https://${label}.test`,
            title: label,
            tabId: typeof args.tabId === 'number' ? args.tabId : 1,
            activeTabId: 1,
            settled: true,
          }
          : method === 'browser_screenshot'
            ? this.screenshotResult
            : method === 'get_upload_target'
              ? { origin: `https://${label}.test`, tabId: typeof args.tabId === 'number' ? args.tabId : 1 }
              : method === 'search_browser_history'
                ? [{ url: `https://${label}.test/history`, title: `History ${label}`, visitedAt: '2026-08-26T00:00:00.000Z' }]
                : method === 'get_cdp_target'
                  ? { origin: `https://${label}.test`, tabId: typeof args.tabId === 'number' ? args.tabId : 1 }
                  : method === 'cdp_command'
                    ? { echo: args.params }
                    : method === 'cdp_read_events'
                      ? cdpEventPage(label, args)
                      : { success: true, message: `${method} on ${label}` }
      void beforeReply(method, args).then(() => {
        this.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`)
      }, (error: unknown) => {
        this.stdout.write(`${JSON.stringify({
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })}\n`)
      })
    })
    this.stdin.on('finish', () => this.emit('exit'))
    if (ready) queueMicrotask(() => this.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`))
  }

  kill(): void {
    this.killed = true
    this.emit('exit')
  }
}

interface HarnessOptions {
  approval?: ApprovalOutcome | false | ((request: ApprovalRequest) => Promise<ApprovalOutcome>)
  allowFullCdpAccess?: boolean
  config?: Config
}

async function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const approval = options.approval ?? 'allowed-once'
  if (approval !== false) {
    await ctx.plugin(ApprovalService)
    ctx.on('approval/request', request =>
      typeof approval === 'function' ? approval(request) : Promise.resolve(approval))
  }
  await ctx.plugin(MemorySettings)
  const fiber = await ctx.plugin(BrowserSessionService, {
    electronPath: '/fake/electron',
    show: false,
    ...options.allowFullCdpAccess === undefined ? {} : { allowFullCdpAccess: options.allowFullCdpAccess },
    ...options.config,
  })
  await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { navigationPolicy: 'allow' })
  const spawned: ScriptedChild[] = []
  ctx.browsers.spawnChild = () => {
    const child = new ScriptedChild(`child-${spawned.length}`)
    spawned.push(child)
    return child
  }
  return { ctx, spawned, dispose: async () => { await fiber.dispose() } }
}

describe('BrowserSessionService', () => {
  it.each(['relative', 'file:///private'])('rejects an invalid initial page %s', (homeUrl) => {
    expect(() => new BrowserSessionService(new Context(), { homeUrl })).toThrow('absolute http(s) URL')
  })

  it.each(['http://example.test', 'https://example.test'])('passes the normalized home page %s', async (homeUrl) => {
    const { ctx, dispose } = await harness({ config: { homeUrl, userDataDir: '/custom/profile' } })
    const spawn = vi.fn(() => new ScriptedChild('home'))
    ctx.browsers.spawnChild = spawn
    await ctx.browsers.perform(stubAgent(ctx, 'home'), { method: 'get_browser_state' })
    const args = vi.mocked(ctx.browsers.spawnChild).mock.calls[0]!
    expect(JSON.parse(args[1][1]!)).toMatchObject({ homeUrl: `${homeUrl}/`, userDataDir: '/custom/profile' })
    await dispose()
  })

  it('rejects malformed screenshot metadata and timestamps from Electron', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'screenshot')
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    for (const value of [null, [], { ...screenshot('bad'), mediaType: 'image/jpeg' },
      { ...screenshot('bad'), capturedAt: 'invalid' }]) {
      spawned[0]!.responses.set('browser_screenshot', value)
      await expect(ctx.browsers.takeScreenshot(owner)).rejects.toThrow('invalid screenshot')
    }
    await dispose()
  })

  it('rejects malformed child history, page identity, and CDP replies', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'wire')
    owner.session.append('turn/start', { turn: 1 })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { historyAccessPolicy: 'allow', fullCdpAccess: true })
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    const child = spawned[0]!
    const history = { url: 'https://example.test', title: 'Page', visitedAt: '2026-09-01' }
    for (const value of [null, Array.from({ length: 21 }, () => history), [null], [{}],
      [{ ...history, url: 'invalid' }], [{ ...history, url: 'file:///private' }]]) {
      child.responses.set('search_browser_history', value)
      await expect(ctx.browsers.searchHistory(owner, 'page')).rejects.toThrow('invalid history')
    }
    const identity = { url: 'https://example.test', title: 'Page', tabId: 1, activeTabId: 1, settled: true }
    for (const value of [null, [], {}, { ...identity, url: 'invalid' }, { ...identity, tabId: 2 }]) {
      child.responses.set('get_page_identity', value)
      await expect(ctx.browsers.currentPage(owner, {}, 1)).rejects.toThrow(/invalid page|wrong tab/)
    }
    child.responses.set('get_page_identity', identity)
    await expect(ctx.browsers.currentPage(owner, {}, 1)).resolves.toEqual(identity)
    for (const value of [null, [], { data: 'x'.repeat(1_048_576) }]) {
      child.responses.set('cdp_command', value)
      await expect(ctx.browsers.sendCdpCommand(owner, 'Runtime.evaluate', {}, undefined)).rejects.toThrow(/CDP result/)
    }
    for (const value of [null, [], {}, { nextSequence: 0, events: [], data: 'x'.repeat(1_048_576) },
      { nextSequence: 0, events: [null] }, { nextSequence: 0, events: [{}] }]) {
      child.responses.set('cdp_read_events', value)
      await expect(ctx.browsers.readCdpEvents(owner, {})).rejects.toThrow(/CDP event/)
    }
    for (const method of ['get_cdp_target', 'get_upload_target']) {
      child.responses.set(method, {})
      if (method === 'get_upload_target') {
        await expect(ctx.browsers.perform(owner, { method: 'upload_file', filePath: UPLOAD_FIXTURE, index: 1 }))
          .rejects.toThrow('upload target is unavailable')
      } else {
        await expect(ctx.browsers.sendCdpCommand(owner, 'Runtime.evaluate', {}, undefined)).rejects.toThrow('CDP target is unavailable')
        await expect(ctx.browsers.readCdpEvents(owner, {})).rejects.toThrow('CDP target is unavailable')
      }
    }
    await dispose()
  })

  it('validates file, query and CDP inputs before dispatch', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'inputs')
    for (const tabId of [0, 1.5]) {
      await expect(ctx.browsers.currentPage(owner, {}, tabId)).rejects.toThrow('tabId')
      await expect(ctx.browsers.sendCdpCommand(owner, 'Runtime.evaluate', {}, tabId)).rejects.toThrow('tabId')
    }
    for (const query of [' ', 'x'.repeat(257)]) await expect(ctx.browsers.searchHistory(owner, query)).rejects.toThrow('query')
    for (const method of ['Runtime', `${'x'.repeat(129)}.evaluate`]) {
      await expect(ctx.browsers.sendCdpCommand(owner, method, {}, undefined)).rejects.toThrow('syntax')
    }
    for (const params of [null, []]) {
      await expect(ctx.browsers.sendCdpCommand(owner, 'Runtime.evaluate', params, undefined)).rejects.toThrow('JSON object')
    }
    await expect(ctx.browsers.perform(owner, { method: 'upload_file', index: 1, filePath: 'relative.txt' })).rejects.toThrow('absolute')
    await expect(ctx.browsers.perform(owner, { method: 'upload_file', index: 1, filePath: fileURLToPath(new URL('.', import.meta.url)) }))
      .rejects.toThrow('regular file')
    expect(spawned).toHaveLength(0)
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })
    for (const method of ['DOM.setFileInputFiles', 'Input.dispatchDragEvent']) {
      await expect(ctx.browsers.sendCdpCommand(owner, method, {}, undefined)).rejects.toThrow('Use browser_upload_file')
    }
    await dispose()
  })

  it('binds every dropped file to the explicit approved tab', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'drop')
    owner.session.append('turn/start', { turn: 1 })
    await ctx.browsers.perform(owner, { method: 'drop', index: 1, filePaths: [UPLOAD_FIXTURE], data: {}, tabId: 2 })
    expect(spawned[0]!.requests).toContainEqual({
      method: 'drop', args: { index: 1, filePaths: [realpathSync(UPLOAD_FIXTURE)], data: {}, tabId: 2, expectedOrigin: 'https://child-0.test' },
    })
    await dispose()
  })

  it('rejects reads, screenshots and CDP after control is disabled or the service is disposed', async () => {
    const { ctx, dispose } = await harness()
    const owner = stubAgent(ctx, 'disabled')
    const service = ctx.browsers
    await service.perform(owner, { method: 'get_browser_state' })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { controlEnabled: false })
    const calls = [() => service.takeScreenshot(owner), () => service.searchHistory(owner, 'page'),
      () => service.sendCdpCommand(owner, 'Runtime.evaluate', {}, undefined)]
    await expect(service.currentPage(owner)).rejects.toMatchObject({ code: 'BROWSER_DISABLED' })
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'BROWSER_DISABLED' })
    await dispose()
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'BROWSER_DISPOSING' })
  })

  it('requires the approval service even after CDP is enabled', async () => {
    const { ctx, dispose } = await harness({ approval: false })
    const owner = stubAgent(ctx, 'approval')
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })
    await expect(ctx.browsers.sendCdpCommand(owner, 'Runtime.evaluate', {}, undefined)).rejects.toThrow('no approval service')
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { navigationPolicy: 'ask' })
    await expect(ctx.browsers.perform(owner, { method: 'get_browser_state' })).rejects.toThrow('no approval service')
    await dispose()
  })

  it.each(['disabled', 'blocked'])('rechecks browsing after approval becomes %s', async (change) => {
    const decision = Promise.withResolvers<ApprovalOutcome>()
    const approval = vi.fn(() => decision.promise)
    const { ctx, spawned, dispose } = await harness({ approval })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { navigationPolicy: 'ask' })
    const owner = stubAgent(ctx, 'revoked')
    owner.session.append('turn/start', { turn: 1 })
    const action = ctx.browsers.perform(owner, { method: 'get_browser_state' })
    const rejected = expect(action).rejects.toThrow('was not approved')
    await vi.waitFor(() => { expect(approval).toHaveBeenCalledOnce() })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, change === 'disabled' ? { controlEnabled: false } : { navigationPolicy: 'block' })
    decision.resolve('allowed-once')
    await rejected
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('denies native media without a question provider and routes download filenames to approval', async () => {
    const approval = vi.fn((_request: ApprovalRequest) => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const { ctx, spawned, dispose } = await harness({ approval })
    const owner = stubAgent(ctx, 'native')
    owner.session.append('turn/start', { turn: 1 })
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    const child = spawned[0]!
    for (const [id, request] of [
      [1, { kind: 'media', origin: 'https://example.test' }],
      [2, { kind: 'download', origin: 'https://example.test', filename: 'report.pdf' }],
      [3, { kind: 'navigation', origin: 'https://example.test' }],
    ] as const) {
      child.stdout.write(`${JSON.stringify({ event: 'browser:permission', id, request })}\n`)
      await vi.waitFor(() => { expect(child.requests.find(row => row.method === 'browser_permission_response' && row.args.id === id))
        .toMatchObject({ args: id === 1 ? { id } : { id, choice: 'once' } }) })
    }
    expect(approval.mock.calls[0]?.[0].reason).toContain('report.pdf from https://example.test')
    await dispose()
  })

  it.each([
    { selected: ['Allow once'], choice: 'once' }, { selected: ['Always allow'], choice: 'always' },
    { selected: ['Block'], choice: 'block' }, { selected: ['unexpected'] },
    { selected: [] }, { selected: ['Allow once', 'Block'] }, { selected: ['Allow once'], custom: 'typed' },
  ])('maps media permission answers %j', async ({ selected, choice, ...answer }) => {
    const { ctx, spawned, dispose } = await harness()
    await ctx.plugin(UserQuestionService)
    ctx.userQuestions.registerProvider({ ask: async () => ({ answers: [{ id: 'browser-permission', selected, ...answer }] }) })
    const owner = stubAgent(ctx, 'media')
    ctx.agents.register(owner)
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    const child = spawned[0]!
    child.stdout.write(`${JSON.stringify({ event: 'browser:permission', id: 1, request: { kind: 'media', origin: 'https://example.test' } })}\n`)
    await vi.waitFor(() => { expect(child.requests.find(row => row.method === 'browser_permission_response')?.args)
      .toEqual(choice === undefined ? { id: 1 } : { id: 1, choice }) })
    await dispose()
  })

  it('uses the selected Hydra model for a native PageAgent request', async () => {
    const { ctx, spawned, dispose } = await harness()
    await ctx.plugin(LlmRuntime)
    class Model extends LlmAdapter {
      async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
    }
    ctx.llm.registerAdapter(['test'], new Model())
    const scope = ctx.plugin({ inject: ['llm'], apply() {} })
    await scope.await()
    const owner = { ...stubAgent(ctx, 'model'), ctx: scope.ctx, options: { provider: 'test', model: 'test' } }
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    const child = spawned[0]!
    child.stdout.write(`${JSON.stringify({ event: 'page-agent:llm', id: 1, tabId: 1, request: { messages: [{ role: 'user', content: 'Inspect' }] } })}\n`)
    await vi.waitFor(() => { expect(child.requests.find(row => row.method === 'page_agent_llm_response')).toBeDefined() })
    const response = child.requests.find(row => row.method === 'page_agent_llm_response')!.args
    expect(response.error).toBeUndefined()
    expect(response).toMatchObject({ callId: 1, ok: true })
    await dispose()
  })

  it('applies settings changed during startup and fails closed when control is revoked', async () => {
    const { ctx, dispose } = await harness()
    const spawned = Promise.withResolvers<ScriptedChild>()
    ctx.browsers.spawnChild = () => {
      const child = new ScriptedChild('starting', undefined, undefined, false)
      spawned.resolve(child)
      return child
    }
    const action = ctx.browsers.perform(stubAgent(ctx, 'starting'), { method: 'get_browser_state' })
    const rejected = expect(action).rejects.toMatchObject({ code: 'BROWSER_DISABLED' })
    const child = await spawned.promise
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { controlEnabled: false, webDestination: 'system' })
    child.stdout.write('{"event":"ready"}\n')
    await rejected
    expect(child.requests).toContainEqual(expect.objectContaining({ method: 'configure_browser' }))
    await dispose()
  })

  it.each(['owner', 'service'])('closes a browser that becomes ready while its %s is ending', async (scope) => {
    const { ctx, dispose } = await harness()
    const owner = stubAgent(ctx, 'ready-race')
    const spawned = Promise.withResolvers<ScriptedChild>()
    ctx.browsers.spawnChild = () => {
      const child = new ScriptedChild('ready', undefined, undefined, false)
      spawned.resolve(child)
      return child
    }
    const service = ctx.browsers
    const action = service.perform(owner, { method: 'get_browser_state' })
    const settled = Promise.allSettled([action])
    const child = await spawned.promise
    child.stdout.write('{"event":"ready"}\n')
    if (scope === 'owner') await service.close(owner)
    else await dispose()
    await settled
    expect(child.stdin.writableEnded).toBe(true)
    if (scope === 'owner') await dispose()
  })

  it.each([false, true])('reports settings dispatch failures unless disposal is in progress (%s)', async (ending) => {
    const { ctx, dispose } = await harness()
    const failure = Promise.withResolvers<undefined>()
    const requests: string[] = []
    ctx.browsers.spawnChild = () => new ScriptedChild('failed', async (method) => {
      if (method === 'configure_browser' || method === 'page_agent_stop') {
        requests.push(method)
        await failure.promise
      }
    })
    await ctx.browsers.perform(stubAgent(ctx, 'failed'), { method: 'get_browser_state' })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { controlEnabled: false })
    await vi.waitFor(() => { expect(requests).toHaveLength(2) })
    const disposal = ending ? dispose() : undefined
    failure.reject(new Error('child failed'))
    await disposal
    if (!ending) {
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(2) })
      await dispose()
    }
    warn.mockRestore()
  })

  it('serializes tab lifecycle actions and lets stop run after browsing is blocked', async () => {
    const { ctx, dispose } = await harness()
    const owner = stubAgent(ctx, 'tabs')
    for (const method of ['open_new_tab', 'switch_to_tab', 'close_tab'] as const) {
      await ctx.browsers.perform(owner, { method, tabId: 1 }, { captureState: false })
    }
    expect(ctx.browsers.experimentalScriptExecution).toBe(false)
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { navigationPolicy: 'block' })
    await expect(ctx.browsers.perform(owner, { method: 'page_agent_stop' })).resolves.toHaveProperty('action.success', true)
    await dispose()
  })

  it.each(['browsing', 'downloads', 'uploads'] as const)('enforces all three global modes for %s', async (capability) => {
    for (const mode of ['allow', 'ask', 'block'] as const) {
      const decision = Promise.withResolvers<ApprovalOutcome>()
      const approval = vi.fn(() => decision.promise)
      const { ctx, spawned, dispose } = await harness({ approval })
      const owner = stubAgent(ctx, 'permission-matrix')
      owner.session.append('turn/start', { turn: 1 })
      owner.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Upload the generated artifact.' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      if (capability === 'downloads') await ctx.browsers.perform(owner, { method: 'get_browser_state' })
      const permissions = { browsing: 'allow', downloads: 'allow', uploads: 'allow', [capability]: mode }
      await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { browserPermissions: permissions })
      let result: Promise<unknown>
      if (capability === 'downloads') {
        const child = spawned[0]!
        child.stdout.write(`${JSON.stringify({
          event: 'browser:permission', id: 42,
          request: { kind: 'download', origin: 'https://second.test', filename: 'report.zip' },
        })}\n`)
        result = vi.waitFor(() => {
          const response = child.requests.find(request => request.method === 'browser_permission_response')
          expect(response?.args.id).toBe(42)
          expect(response?.args.choice).toBe(mode === 'block' ? undefined : 'once')
        })
      } else {
        const action = ctx.browsers.perform(owner, capability === 'browsing'
          ? { method: 'navigate', url: 'https://second.test' }
          : { method: 'upload_file', index: 3, filePath: UPLOAD_FIXTURE })
        result = mode === 'block'
          ? expect(action).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
          : action
      }
      if (mode === 'ask') {
        await vi.waitFor(() => { expect(approval).toHaveBeenCalledOnce() })
        expect(spawned.flatMap(child => child.seen)).not.toContain(capability === 'uploads' ? 'upload_file' : 'navigate')
        if (capability === 'downloads') expect(spawned[0]!.seen).not.toContain('browser_permission_response')
        decision.resolve('allowed-once')
      }
      await result
      if (mode !== 'ask') expect(approval).not.toHaveBeenCalled()
      expect(ctx.settings.describe().find(row => row.ns === BROWSER_SETTINGS_NAMESPACE)?.value)
        .toMatchObject({ browserPermissions: permissions })
      await dispose()
    }
  })
  it('applies global capability modes independently before execution', async () => {
    const { ctx, spawned, dispose } = await harness({ approval: false })
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, {
      browserPermissions: { browsing: 'block', downloads: 'allow', uploads: 'ask' },
    })
    await expect(ctx.browsers.perform(owner, { method: 'navigate', url: 'https://example.test' }))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(spawned).toHaveLength(0)

    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, {
      browserPermissions: { browsing: 'allow', downloads: 'allow', uploads: 'block' },
    })
    owner.session.append('turn/start', { turn: 1 })
    owner.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Use ${UPLOAD_FIXTURE}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expect(ctx.browsers.perform(owner, { method: 'upload_file', index: 3, filePath: UPLOAD_FIXTURE }))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(spawned).toHaveLength(0)
    await dispose()
  })
  it.each(['action', 'owner', 'service'])('cancels startup when its %s is stopped', async (stopped) => {
    const { ctx, dispose } = await harness()
    const owner = stubAgent(ctx, 'starting')
    const controller = new AbortController()
    const spawned = Promise.withResolvers<ScriptedChild>()
    ctx.browsers.spawnChild = () => {
      const child = new ScriptedChild('starting', undefined, undefined, false)
      spawned.resolve(child)
      return child
    }
    const service = ctx.browsers
    const action = service.perform(owner, { method: 'get_browser_state' }, { signal: controller.signal })
    const rejected = expect(action).rejects.toMatchObject({ name: 'AbortError' })
    const child = await spawned.promise
    if (stopped === 'action') controller.abort()
    else if (stopped === 'owner') await disposeAgentScope(owner)
    else await dispose()
    await rejected
    expect(child.stdin.writableEnded).toBe(true)
    expect(await service.close(owner)).toBe(false)
    if (stopped !== 'service') await dispose()
  })

  it('starts one window on the first action and reuses it after that', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    expect(spawned).toHaveLength(0)

    const first = await ctx.browsers.perform(owner, { method: 'navigate', url: 'https://example.test' })
    expect(spawned).toHaveLength(1)
    expect(first.action).toEqual({ success: true, message: 'navigate on child-0' })
    expect(first.state.title).toBe('child-0')

    await ctx.browsers.perform(owner, { method: 'click_element', index: 2 })
    await ctx.browsers.perform(owner, { method: 'find_element', query: 'Requester' })
    await ctx.browsers.perform(owner, { method: 'fill_fields', fields: [{ name: 'who', text: 'Ada' }] })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.seen).toEqual([
      'navigate', 'get_browser_state', 'click_element', 'get_browser_state',
      'find_element', 'get_browser_state', 'fill_fields', 'get_browser_state',
    ])

    await dispose()
  })

  it('reads state without claiming an action was taken', async () => {
    const { ctx, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    const outcome = await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    expect(outcome).not.toHaveProperty('action')
    expect(outcome.state.url).toBe('https://child-0.test')
    await dispose()
  })

  it('returns no page without starting an owner browser', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')

    await expect(ctx.browsers.currentPage(owner)).resolves.toBeUndefined()
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('reads live page identity through the child without requesting browser state', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    spawned[0]?.requests.splice(0)

    await expect(ctx.browsers.currentPage(owner)).resolves.toEqual({
      url: 'https://child-0.test',
      title: 'child-0',
      tabId: 1,
      activeTabId: 1,
      settled: true,
    })
    expect(spawned[0]?.requests).toEqual([{ method: 'get_page_identity', args: {} }])
    await dispose()
  })

  it('applies browsing policy to an existing page identity read', async () => {
    const { ctx, spawned, dispose } = await harness({ approval: false })
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, {
      browserPermissions: { browsing: 'block', downloads: 'allow', uploads: 'allow' },
    })

    await expect(ctx.browsers.currentPage(owner)).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(spawned[0]?.seen).not.toContain('get_page_identity')
    await dispose()
  })

  it('does not prompt for a background page identity read under ask policy', async () => {
    const approval = vi.fn(() => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const { ctx, spawned, dispose } = await harness({ approval })
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, {
      browserPermissions: { browsing: 'ask', downloads: 'allow', uploads: 'allow' },
    })

    await expect(ctx.browsers.currentPage(owner)).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(approval).not.toHaveBeenCalled()
    expect(spawned[0]?.seen).not.toContain('get_page_identity')
    await dispose()
  })

  it('shares browsing approval within an active logged call while rechecking policy and reused ids', async () => {
    const approval = vi.fn(() => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const { ctx, dispose } = await harness({ approval })
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, {
      browserPermissions: { browsing: 'ask', downloads: 'allow', uploads: 'allow' },
    })
    const callId = CallId('reused-id')
    const execution = { callId, signal: new AbortController().signal }
    const call = { turn: 1, step: 1, callId, name: 'browser_click', arguments: '{"target":"#save"}' }
    owner.session.append('turn/start', { turn: 1 })
    const callSeq = owner.session.events.length
    owner.session.append('tool/call', call)
    await ctx.browsers.currentPage(owner, execution)
    await ctx.browsers.perform(owner, { method: 'get_browser_state', snapshot: { target: '#title' } }, execution)
    await ctx.browsers.perform(owner, { method: 'click_element', target: '#save' }, execution)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(approval).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: 'browser_click' }))
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, {
      browserPermissions: { browsing: 'block', downloads: 'allow', uploads: 'allow' },
    })
    await expect(ctx.browsers.currentPage(owner, execution)).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, {
      browserPermissions: { browsing: 'ask', downloads: 'allow', uploads: 'allow' },
    })
    await expect(ctx.browsers.currentPage(owner, { callId, signal: AbortSignal.abort() })).rejects.toBeDefined()
    owner.session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId, content: [], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    await ctx.browsers.currentPage(owner, execution)
    expect(approval).toHaveBeenCalledTimes(2)
    owner.session.append('tool/call', { ...call, step: 2 })
    await ctx.browsers.currentPage(owner, execution)
    expect(approval).toHaveBeenCalledTimes(3)
    await ctx.browsers.currentPage(owner, execution)
    expect(approval).toHaveBeenCalledTimes(3)
    await dispose()
  })

  it('captures and validates the selected viewport without accepting a tab target', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')

    await expect(ctx.browsers.takeScreenshot(owner)).resolves.toEqual(screenshot('child-0'))
    expect(spawned[0]?.requests).toEqual([{ method: 'browser_screenshot', args: {} }])
    await dispose()
  })

  it('rejects malformed, non-HTTP(S), or out-of-bounds screenshot results', async () => {
    const oversizedPng = Buffer.from(PNG_1X1)
    oversizedPng.writeUInt32BE(2_001, 16)
    const cases: Array<{ value: unknown; message: RegExp }> = [
      { value: { ...screenshot('bad-base64'), data: `${PNG_1X1.toString('base64')}=` }, message: /canonical base64/ },
      { value: { ...screenshot('bad-bytes'), bytes: PNG_1X1.length + 1 }, message: /invalid PNG/ },
      { value: { ...screenshot('bad-size'), width: 2 }, message: /mismatched screenshot dimensions/ },
      {
        value: {
          ...screenshot('oversized'),
          data: oversizedPng.toString('base64'),
          bytes: oversizedPng.length,
          width: 2_001,
        },
        message: /configured bounds/,
      },
      { value: { ...screenshot('wrong-page'), url: 'about:blank' }, message: /non-HTTP\(S\)/ },
    ]

    for (const [index, test] of cases.entries()) {
      const { ctx, spawned, dispose } = await harness()
      const owner = stubAgent(ctx, `invalid-${index}`)
      ctx.browsers.spawnChild = () => {
        const child = new ScriptedChild(`invalid-${index}`, undefined, test.value)
        spawned.push(child)
        return child
      }
      await expect(ctx.browsers.takeScreenshot(owner)).rejects.toThrow(test.message)
      await dispose()
    }
  })

  it('sends an action as its method name plus every remaining property', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.browsers.perform(owner, { method: 'scroll', down: true, numPages: 1, pixels: 200 })
    expect(spawned[0]?.requests[0]).toEqual({
      method: 'scroll',
      args: { down: true, numPages: 1, pixels: 200 },
    })
    await dispose()
  })

  it('rejects experimental JavaScript before starting a browser unless the host enabled it', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    await expect(ctx.browsers.perform(owner, { method: 'execute_javascript', script: 'return document.title' }))
      .rejects.toThrow('experimental browser JavaScript is disabled by the host')
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('resolves and validates an upload file before exposing it to Electron', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    const missing = `${UPLOAD_FIXTURE}.missing`
    owner.session.append('turn/start', { turn: 1 })
    owner.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Use ${UPLOAD_FIXTURE} or ${missing}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const callId = CallId('upload-call')
    const signal = new AbortController().signal
    await ctx.browsers.perform(
      owner,
      { method: 'upload_file', index: 3, filePath: UPLOAD_FIXTURE },
      { callId, signal },
    )
    expect(spawned[0]?.requests.slice(0, 2)).toEqual([
      { method: 'get_upload_target', args: {} },
      {
        method: 'upload_file',
        args: {
          index: 3,
          filePath: realpathSync(UPLOAD_FIXTURE),
          expectedOrigin: 'https://child-0.test',
          tabId: 1,
        },
      },
    ])
    expect(owner.session.events.find(event => event.type === 'approval/asked')?.data).toMatchObject({
      callId,
      reason: `Browser permissions: uploads. Action: browser_upload_file. Upload ${realpathSync(UPLOAD_FIXTURE)} to https://child-0.test in tab [1] through input [3].`,
    })
    await expect(ctx.browsers.perform(owner, { method: 'upload_file', index: 3, filePath: missing }))
      .rejects.toThrow(/existing readable regular file/)
    expect(spawned[0]?.requests.some(request => request.args.filePath === missing)).toBe(false)
    await dispose()
  })

  it('requires upload approval for a generated file even when its path is absent from the user message', async () => {
    const decision = Promise.withResolvers<ApprovalOutcome>()
    const approval = vi.fn((_request: ApprovalRequest) => decision.promise)
    const { ctx, spawned, dispose } = await harness({ approval })
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })
    owner.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Upload the generated artifact.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const upload = ctx.browsers.perform(owner, { method: 'upload_file', index: 3, filePath: UPLOAD_FIXTURE })
    const denied = expect(upload).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await vi.waitFor(() => { expect(approval).toHaveBeenCalledOnce() })
    expect(approval.mock.calls[0]?.[0].reason).toContain(realpathSync(UPLOAD_FIXTURE))
    expect(spawned.flatMap(child => child.seen)).not.toContain('upload_file')
    decision.resolve('rejected')
    await denied
    expect(spawned.flatMap(child => child.seen)).not.toContain('upload_file')
    await dispose()
  })

  it('blocks uploads before exposing a file to Electron', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })
    owner.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Use ${UPLOAD_FIXTURE}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { uploadPolicy: 'block' })

    await expect(ctx.browsers.perform(owner, { method: 'upload_file', index: 3, filePath: UPLOAD_FIXTURE }))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('allows history without prompting and sends only the bounded search contract', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { historyAccessPolicy: 'allow' })

    await expect(ctx.browsers.searchHistory(owner, ' orders ')).resolves.toEqual([{
      url: 'https://child-0.test/history',
      title: 'History child-0',
      visitedAt: '2026-08-26T00:00:00.000Z',
    }])
    expect(spawned[0]?.requests).toEqual([{
      method: 'search_browser_history',
      args: { query: 'orders', limit: 20 },
    }])
    expect(owner.session.events.some(event => event.type === 'approval/asked')).toBe(false)
    await dispose()
  })

  it('blocks history before starting Electron', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { historyAccessPolicy: 'block' })

    await expect(ctx.browsers.searchHistory(owner, 'orders'))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('waits for explicit history approval before starting Electron', async () => {
    const decision = Promise.withResolvers<ApprovalOutcome>()
    const asked = Promise.withResolvers<ApprovalRequest>()
    const { ctx, spawned, dispose } = await harness({
      approval: (request) => {
        asked.resolve(request)
        return decision.promise
      },
    })
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })
    const callId = CallId('history-call')
    const signal = new AbortController().signal

    const search = ctx.browsers.searchHistory(owner, 'orders', { callId, signal })
    const request = await asked.promise
    expect(request.agent).toBe(owner)
    expect(request.signal).toBe(signal)
    expect(request).toMatchObject({
      toolName: 'browser_history_search',
      reason: 'Search sensitive Browser history for "orders".',
      callId,
    })
    expect(spawned).toHaveLength(0)
    decision.resolve('allowed-once')
    await expect(search).resolves.toHaveLength(1)
    expect(spawned[0]?.requests[0]).toEqual({
      method: 'search_browser_history',
      args: { query: 'orders', limit: 20 },
    })
    await dispose()
  })

  it('denies an unapproved history search without starting Electron', async () => {
    const { ctx, spawned, dispose } = await harness({ approval: 'rejected' })
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })

    await expect(ctx.browsers.searchHistory(owner, 'orders'))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('fails closed when history approval is unavailable', async () => {
    const { ctx, spawned, dispose } = await harness({ approval: false })
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })

    await expect(ctx.browsers.searchHistory(owner, 'orders'))
      .rejects.toThrow('no approval service is available')
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('keeps CDP disabled until the user opts in', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')

    await expect(ctx.browsers.sendCdpCommand(owner, 'Runtime.evaluate', {}, undefined))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await expect(ctx.browsers.readCdpEvents(owner, {}))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('keeps the organization CDP ceiling authoritative', async () => {
    const { ctx, spawned, dispose } = await harness({ allowFullCdpAccess: false })
    const owner = stubAgent(ctx, 'agent-a')
    await expect(ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true }))
      .rejects.toThrow('organization policy disables full CDP access')

    expect(ctx.browsers.fullCdpAccess).toBe(false)
    await expect(ctx.browsers.sendCdpCommand(owner, 'Runtime.evaluate', {}, undefined))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await expect(ctx.browsers.readCdpEvents(owner, {}))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('requires CDP approval and binds the command to the approved tab and origin', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })
    const callId = CallId('cdp-call')
    const signal = new AbortController().signal

    await expect(ctx.browsers.sendCdpCommand(
      owner,
      'Runtime.evaluate',
      { expression: '1 + 1' },
      2,
      { callId, signal },
    )).resolves.toEqual({
      method: 'Runtime.evaluate',
      result: { echo: { expression: '1 + 1' } },
    })
    expect(spawned[0]?.requests).toEqual([
      { method: 'get_cdp_target', args: { tabId: 2 } },
      {
        method: 'cdp_command',
        args: {
          method: 'Runtime.evaluate',
          params: { expression: '1 + 1' },
          expectedOrigin: 'https://child-0.test',
          tabId: 2,
        },
      },
    ])
    expect(owner.session.events.find(event => event.type === 'approval/asked')?.data).toMatchObject({
      callId,
      reason: 'Run CDP Runtime.evaluate on https://child-0.test in tab [2].',
    })
    await dispose()
  })

  it('requires a separate approval to read CDP events and binds the cursor page to its origin', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })

    await ctx.browsers.sendCdpCommand(owner, 'Runtime.enable', {}, 2, {
      callId: CallId('cdp-command-call'),
      signal: new AbortController().signal,
    })
    await expect(ctx.browsers.readCdpEvents(owner, {
      afterSequence: 10,
      limit: 1,
      method: 'Network.responseReceived',
      tabId: 2,
    }, {
      callId: CallId('cdp-events-call'),
      signal: new AbortController().signal,
    })).resolves.toEqual({
      events: [{
        sequence: 12,
        method: 'Network.responseReceived',
        params: { requestId: 'child-0' },
        receivedAt: '2026-08-26T00:00:02.000Z',
      }],
      nextSequence: 12,
    })
    expect(spawned[0]?.requests.slice(-2)).toEqual([
      { method: 'get_cdp_target', args: { tabId: 2 } },
      {
        method: 'cdp_read_events',
        args: {
          afterSequence: 10,
          limit: 1,
          method: 'Network.responseReceived',
          expectedOrigin: 'https://child-0.test',
          tabId: 2,
        },
      },
    ])
    expect(owner.session.events.filter(event => event.type === 'approval/asked').map(event => ({
      toolName: event.data.toolName,
      callId: event.data.callId,
      reason: event.data.reason,
    }))).toEqual([
      {
        toolName: 'browser_cdp_command',
        callId: CallId('cdp-command-call'),
        reason: 'Run CDP Runtime.enable on https://child-0.test in tab [2].',
      },
      {
        toolName: 'browser_cdp_read_events',
        callId: CallId('cdp-events-call'),
        reason: 'Read CDP events from https://child-0.test in tab [2].',
      },
    ])
    await dispose()
  })

  it('denies a CDP event read after target preflight but before reading events', async () => {
    const { ctx, spawned, dispose } = await harness({ approval: 'rejected' })
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })

    await expect(ctx.browsers.readCdpEvents(owner, { tabId: 2 }))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect(spawned[0]?.requests).toEqual([{ method: 'get_cdp_target', args: { tabId: 2 } }])
    await dispose()
  })

  it('does not hide an Electron origin race during an approved CDP event read', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { fullCdpAccess: true })
    ctx.browsers.spawnChild = () => {
      const child = new ScriptedChild('raced', async (method) => {
        if (method === 'cdp_read_events') throw new Error('CDP target changed before events could be read')
      })
      spawned.push(child)
      return child
    }

    await expect(ctx.browsers.readCdpEvents(owner, { tabId: 2 }))
      .rejects.toThrow('CDP target changed before events could be read')
    expect(spawned[0]?.requests).toEqual([
      { method: 'get_cdp_target', args: { tabId: 2 } },
      {
        method: 'cdp_read_events',
        args: {
          afterSequence: 0,
          limit: 100,
          expectedOrigin: 'https://raced.test',
          tabId: 2,
        },
      },
    ])
    await dispose()
  })

  it('rejects invalid CDP event cursor, filter, limit, and tab bounds before starting Electron', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    const cases: Array<{
      options: { afterSequence?: number; limit?: number; method?: string; tabId?: number }
      message: RegExp
    }> = [
      { options: { afterSequence: -1 }, message: /cursor/ },
      { options: { limit: 0 }, message: /limit/ },
      { options: { limit: 101 }, message: /limit/ },
      { options: { method: 'Runtime' }, message: /method filter/ },
      { options: { tabId: 0 }, message: /tabId/ },
    ]
    for (const { options, message } of cases) {
      await expect(ctx.browsers.readCdpEvents(owner, options)).rejects.toThrow(message)
    }
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('rejects cross-target CDP domains before starting Electron', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    for (const method of ['Browser.getVersion', 'SystemInfo.getInfo', 'Target.createTarget', 'Tethering.bind']) {
      await expect(ctx.browsers.sendCdpCommand(owner, method, {}, undefined))
        .rejects.toThrow(/unavailable outside the controlled tab/)
    }
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('rejects oversized CDP params before starting Electron', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')

    await expect(ctx.browsers.sendCdpCommand(
      owner,
      'Runtime.evaluate',
      { expression: 'x'.repeat(65_536) },
      undefined,
    )).rejects.toThrow('CDP params exceed 65536 bytes')
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('gives each agent its own window', async () => {
    const { ctx, spawned, dispose } = await harness()
    const first = stubAgent(ctx, 'agent-a')
    const second = stubAgent(ctx, 'agent-b')
    const a = await ctx.browsers.perform(first, { method: 'get_browser_state' })
    const b = await ctx.browsers.perform(second, { method: 'get_browser_state' })
    expect(spawned).toHaveLength(2)
    expect([a.state.title, b.state.title]).toEqual(['child-0', 'child-1'])
    await dispose()
  })

  it('runs actions for one explicit tab in order', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    await Promise.all([
      ctx.browsers.perform(owner, { method: 'click_element', index: 1, tabId: 1 }),
      ctx.browsers.perform(owner, { method: 'input_text', index: 2, text: 'x', tabId: 1 }),
    ])
    // Interleaving would put the two actions next to each other.
    expect(spawned[0]?.seen).toEqual([
      'click_element', 'get_browser_state', 'input_text', 'get_browser_state',
    ])
    await dispose()
  })

  it('overlaps different explicit tabs while preserving one browser window', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    const bothStarted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let started = 0
    ctx.browsers.spawnChild = () => {
      const child = new ScriptedChild('parallel', async (method) => {
        if (method !== 'click_element') return
        started += 1
        if (started === 2) bothStarted.resolve(undefined)
        await release.promise
      })
      spawned.push(child)
      return child
    }

    const calls = Promise.all([
      ctx.browsers.perform(owner, { method: 'click_element', index: 1, tabId: 1 }),
      ctx.browsers.perform(owner, { method: 'click_element', index: 2, tabId: 2 }),
    ])
    const timeout = setTimeout(() => {
      bothStarted.reject(new Error('different tab actions did not overlap'))
    }, 1_000)
    try {
      await bothStarted.promise
      release.resolve(undefined)
      await calls

      expect(spawned).toHaveLength(1)
      expect(spawned[0]?.requests.slice(0, 2)).toEqual([
        { method: 'click_element', args: { index: 1, tabId: 1 } },
        { method: 'click_element', args: { index: 2, tabId: 2 } },
      ])
    } finally {
      clearTimeout(timeout)
      release.resolve(undefined)
      await Promise.allSettled([calls])
      await dispose()
    }
  })

  it('starts a fresh window after the user closes the old one', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    spawned[0]?.emit('exit')
    const after = await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    expect(spawned).toHaveLength(2)
    expect(after.state.title).toBe('child-1')
    await dispose()
  })

  it('closes an agent window with the agent', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    await ctx.browsers.perform(owner, { method: 'get_browser_state' })
    await disposeAgentScope(owner)
    expect(spawned[0]?.stdin.writableEnded).toBe(true)
    // A second close has nothing left to do.
    expect(await ctx.browsers.close(owner)).toBe(false)
    await dispose()
  })

  it('closes every window when the service goes away, and refuses later work', async () => {
    const { ctx, spawned, dispose } = await harness()
    const first = stubAgent(ctx, 'agent-a')
    const second = stubAgent(ctx, 'agent-b')
    await ctx.browsers.perform(first, { method: 'get_browser_state' })
    await ctx.browsers.perform(second, { method: 'get_browser_state' })
    const service = ctx.browsers
    await dispose()
    expect(spawned.map(child => child.stdin.writableEnded)).toEqual([true, true])
    await expect(service.perform(first, { method: 'get_browser_state' }))
      .rejects.toMatchObject({ code: 'BROWSER_DISPOSING' })
  })
})
