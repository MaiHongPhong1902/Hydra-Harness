import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@bosch/cordis'
import { createUserMessage } from '@bosch/bh-llm'
import AgentRegistry, { Inbox } from '@bosch/bh-agent'
import type { Agent } from '@bosch/bh-agent'
import { Session, SessionId } from '@bosch/bh-session'
import BrowserSessionService from '@bosch/bh-browser-electron'
import type { BrowserChildProcess } from '@bosch/bh-browser-electron'

const agentScopeDisposers = new WeakMap<Agent, () => Promise<void>>()
const UPLOAD_FIXTURE = fileURLToPath(new URL('./fixtures/form.html', import.meta.url))

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
        : { success: true, message: `${method} on ${label}` }
      void beforeReply(method, args).then(() => {
        this.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`)
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

async function harness() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(BrowserSessionService, { electronPath: '/fake/electron', show: false })
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
    await ctx.browsers.perform(owner, { method: 'upload_file', index: 3, filePath: UPLOAD_FIXTURE })
    expect(spawned[0]?.requests[0]).toEqual({
      method: 'upload_file',
      args: { index: 3, filePath: realpathSync(UPLOAD_FIXTURE) },
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
