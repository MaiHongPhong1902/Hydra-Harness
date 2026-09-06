import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@hydra/cordis'
import { CallId, createUserMessage } from '@hydra/harness-llm'
import AgentRegistry, { Inbox } from '@hydra/harness-agent'
import type { Agent } from '@hydra/harness-agent'
import { Session, SessionId } from '@hydra/harness-session'
import { SettingsProvider } from '@hydra/harness-settings'
import type { SettingsNamespace } from '@hydra/harness-settings'
import ApprovalService from '@hydra/harness-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@hydra/harness-user-approval'
import BrowserSessionService, { BROWSER_SETTINGS_NAMESPACE } from '@hydra/harness-browser-electron'
import type { BrowserChildProcess } from '@hydra/harness-browser-electron'

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
  killed = false

  /** Method names in arrival order. */
  get seen(): string[] {
    return this.requests.map(request => request.method)
  }

  constructor(
    readonly label: string,
    beforeReply: (method: string, args: Record<string, unknown>) => Promise<void> = () => Promise.resolve(),
    readonly screenshotResult: unknown = screenshot(label),
  ) {
    super()
    createInterface({ input: this.stdin }).on('line', (line: string) => {
      const { id, method, args } = JSON.parse(line) as { id: number; method: string; args: Record<string, unknown> }
      this.requests.push({ method, args })
      const result = method === 'get_browser_state'
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
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`))
  }

  kill(): void {
    this.killed = true
    this.emit('exit')
  }
}

interface HarnessOptions {
  approval?: ApprovalOutcome | false | ((request: ApprovalRequest) => Promise<ApprovalOutcome>)
  allowFullCdpAccess?: boolean
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
  })
  const spawned: ScriptedChild[] = []
  ctx.browsers.spawnChild = () => {
    const child = new ScriptedChild(`child-${spawned.length}`)
    spawned.push(child)
    return child
  }
  return { ctx, spawned, dispose: async () => { await fiber.dispose() } }
}

describe('BrowserSessionService', () => {
  it('starts one window on the first action and reuses it after that', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    expect(spawned).toHaveLength(0)

    const first = await ctx.browsers.perform(owner, { method: 'navigate', url: 'https://example.test' })
    expect(spawned).toHaveLength(1)
    expect(first.action).toEqual({ success: true, message: 'navigate on child-0' })
    expect(first.state.title).toBe('child-0')

    await ctx.browsers.perform(owner, { method: 'click_element', index: 2 })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.seen).toEqual([
      'navigate', 'get_browser_state', 'click_element', 'get_browser_state',
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
      reason: `Upload ${realpathSync(UPLOAD_FIXTURE)} to https://child-0.test in tab [1] through input [3].`,
    })
    await expect(ctx.browsers.perform(owner, { method: 'upload_file', index: 3, filePath: missing }))
      .rejects.toThrow(/existing readable regular file/)
    expect(spawned[0]?.requests.some(request => request.args.filePath === missing)).toBe(false)
    await dispose()
  })

  it('does not treat a longer user-named path as authorization for its prefix', async () => {
    const { ctx, spawned, dispose } = await harness()
    const owner = stubAgent(ctx, 'agent-a')
    owner.session.append('turn/start', { turn: 1 })
    owner.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Use ${UPLOAD_FIXTURE}.backup` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expect(ctx.browsers.perform(owner, { method: 'upload_file', index: 3, filePath: UPLOAD_FIXTURE }))
      .rejects.toThrow(/must appear literally/)
    expect(spawned).toHaveLength(0)
    await dispose()
  })

  it('enforces the upload decision after exact-path validation', async () => {
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
