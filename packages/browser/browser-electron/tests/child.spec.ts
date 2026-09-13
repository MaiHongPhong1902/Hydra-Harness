import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { BrowserError, launchBrowser, resolveElectronPath } from '@hydra/harness-browser-electron'
import type { BrowserChild, BrowserChildProcess } from '@hydra/harness-browser-electron'

interface Request {
  id: number
  method: string
  args: Record<string, unknown>
}

/** Stand-in for the Electron child: real streams, scripted replies. */
class FakeElectron extends EventEmitter implements BrowserChildProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  /** Exit when the parent closes stdin, as the real main process does. */
  exitOnStdinEnd = true

  private readonly arrived: Request[] = []
  private readonly waiting: ((request: Request) => void)[] = []

  constructor() {
    super()
    createInterface({ input: this.stdin }).on('line', (line: string) => {
      const request = JSON.parse(line) as Request
      const waiter = this.waiting.shift()
      if (waiter === undefined) this.arrived.push(request)
      else waiter(request)
    })
    this.stdin.on('finish', () => {
      if (this.exitOnStdinEnd) this.emit('exit')
    })
  }

  kill(): void {
    this.killed = true
    this.emit('exit')
  }

  /** Await the next request the parent sends. */
  next(): Promise<Request> {
    const queued = this.arrived.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise<Request>(resolve => this.waiting.push(resolve))
  }

  say(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
}

/** Utility-process parent port used by the unified desktop shell. */
class FakeParentPort extends EventEmitter {
  readonly sent: unknown[] = []
  activeConnectionId?: string | undefined

  postMessage(message: unknown): void {
    this.sent.push(message)
    if (typeof message !== 'object' || message === null || !('type' in message) || !('connectionId' in message)) return
    const connectionId = message.connectionId as string
    if (message.type === 'hydra-browser-connect') {
      if (this.activeConnectionId !== undefined && this.activeConnectionId !== connectionId) {
        const previousId = this.activeConnectionId
        queueMicrotask(() => {
          this.emit('message', { data: { type: 'hydra-browser-close', connectionId: previousId } })
        })
      }
      this.activeConnectionId = connectionId
      queueMicrotask(() => {
        this.emit('message', { data: { type: 'hydra-browser-line', connectionId, line: JSON.stringify({ event: 'ready' }) } })
      })
    } else if (message.type === 'hydra-browser-disconnect') {
      if (this.activeConnectionId === connectionId) this.activeConnectionId = undefined
    } else if (message.type === 'hydra-browser-line' && 'line' in message && typeof message.line === 'string') {
      const request = JSON.parse(message.line) as Request
      queueMicrotask(() => {
        this.emit('message', {
          data: { type: 'hydra-browser-line', connectionId, line: JSON.stringify({ id: request.id, ok: true, result: request.args }) },
        })
      })
    }
  }
}

const options = (fake: FakeElectron, overrides: Record<string, unknown> = {}) => ({
  userDataDir: '/tmp/profile',
  width: 800,
  height: 600,
  show: false,
  startupTimeoutMs: 1_000,
  actionTimeoutMs: 1_000,
  readinessTimeoutMs: 750,
  experimentalScriptExecution: false,
  electronPath: '/fake/electron',
  spawnChild: () => fake,
  ...overrides,
})

/** Start a fake child that reports ready straight away. */
async function started(overrides: Record<string, unknown> = {}): Promise<{ fake: FakeElectron; child: BrowserChild }> {
  const fake = new FakeElectron()
  const launching = launchBrowser(options(fake, overrides))
  fake.say({ event: 'ready' })
  return { fake, child: await launching }
}

describe('launchBrowser startup', () => {
  it('cancels a home-page question and exits even while its startup deadline is paused', async () => {
    vi.useFakeTimers()
    try {
      const fake = new FakeElectron()
      const controller = new AbortController()
      const answer = Promise.withResolvers<'always'>()
      let questionSignal: AbortSignal | undefined
      const launching = launchBrowser(options(fake, {
        signal: controller.signal,
        onPermission: (_request: unknown, signal: AbortSignal) => {
          questionSignal = signal
          return answer.promise
        },
      }))
      const rejected = expect(launching).rejects.toThrow('stopped')
      fake.say({ event: 'browser:permission', id: 1, request: { kind: 'navigation', origin: 'https://example.test' } })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fake.killed).toBe(false)
      expect(questionSignal?.aborted).toBe(false)
      controller.abort(new Error('stopped'))
      await rejected
      expect(questionSignal?.aborted).toBe(true)
      expect(fake.stdin.writableEnded).toBe(true)
      answer.resolve('always')
      await vi.runAllTimersAsync()
    } finally { vi.useRealTimers() }
  })

  it('passes the window settings to the child and waits for its ready line', async () => {
    const fake = new FakeElectron()
    const seen: { command: string; args: string[] } = { command: '', args: [] }
    const launching = launchBrowser(options(fake, {
      spawnChild: (command: string, args: string[]) => {
        seen.command = command
        seen.args = args
        return fake
      },
    }))
    // Electron writes its own noise to stdout before the app is up.
    fake.stdout.write('\r\n')
    fake.say({ event: 'ready' })
    await launching
    expect(seen.command).toBe('/fake/electron')
    expect(seen.args[0]).toMatch(/main\.cjs$/)
    expect(JSON.parse(seen.args[1] ?? '')).toEqual({
      userDataDir: '/tmp/profile',
      width: 800,
      height: 600,
      show: false,
      readinessTimeoutMs: 750,
      experimentalScriptExecution: false,
    })
  })

  it('reports a launch failure with the child stderr when it never becomes ready', async () => {
    const fake = new FakeElectron()
    const launching = launchBrowser(options(fake, { startupTimeoutMs: 20 }))
    fake.stderr.write('libgbm.so.1: cannot open shared object file')
    await expect(launching).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' })
    await expect(launching).rejects.toThrow(/libgbm/)
    expect(fake.killed).toBe(true)
  })

  it('reports a launch failure when the child exits before it is ready', async () => {
    const fake = new FakeElectron()
    const launching = launchBrowser(options(fake))
    fake.emit('exit')
    await expect(launching).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' })
  })

  it('reports a launch failure when the process cannot be spawned at all', async () => {
    const fake = new FakeElectron()
    const launching = launchBrowser(options(fake))
    fake.emit('error', new Error('ENOENT'))
    await expect(launching).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' })
    await expect(launching).rejects.toThrow(/ENOENT/)
  })

  it('keeps only the first failure', async () => {
    const fake = new FakeElectron()
    const launching = launchBrowser(options(fake))
    fake.emit('error', new Error('first'))
    fake.emit('exit')
    await expect(launching).rejects.toThrow(/first/)
  })

  it('reuses the desktop utility-process bridge without spawning Electron', async () => {
    const port = new FakeParentPort()
    const previousBridge = process.env.HYDRA_DESKTOP_BROWSER_BRIDGE
    const previousPort = Object.getOwnPropertyDescriptor(process, 'parentPort')
    process.env.HYDRA_DESKTOP_BROWSER_BRIDGE = 'parent-port'
    Object.defineProperty(process, 'parentPort', { configurable: true, value: port })
    try {
      const fake = new FakeElectron()
      const child = await launchBrowser(options(fake, {
        spawnChild: undefined,
        electronPath: undefined,
      }))
      await expect(child.call('navigate', { url: 'https://example.test' }))
        .resolves.toEqual({ url: 'https://example.test' })
      await child.close()
      expect(port.sent).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'hydra-browser-connect' }),
        expect.objectContaining({ type: 'hydra-browser-disconnect' }),
      ]))
    } finally {
      if (previousBridge === undefined) Reflect.deleteProperty(process.env, 'HYDRA_DESKTOP_BROWSER_BRIDGE')
      else process.env.HYDRA_DESKTOP_BROWSER_BRIDGE = previousBridge
      if (previousPort === undefined) Reflect.deleteProperty(process, 'parentPort')
      else Object.defineProperty(process, 'parentPort', previousPort)
    }
  })

  it('preempts earlier desktop browser connection when another agent connects', async () => {
    const port = new FakeParentPort()
    const previousBridge = process.env.HYDRA_DESKTOP_BROWSER_BRIDGE
    const previousPort = Object.getOwnPropertyDescriptor(process, 'parentPort')
    process.env.HYDRA_DESKTOP_BROWSER_BRIDGE = 'parent-port'
    Object.defineProperty(process, 'parentPort', { configurable: true, value: port })
    try {
      const fake = new FakeElectron()
      const firstChild = await launchBrowser(options(fake, {
        spawnChild: undefined,
        electronPath: undefined,
      }))
      await expect(firstChild.call('navigate', { url: 'https://first.test' }))
        .resolves.toEqual({ url: 'https://first.test' })

      const secondChild = await launchBrowser(options(fake, {
        spawnChild: undefined,
        electronPath: undefined,
      }))
      await expect(secondChild.call('navigate', { url: 'https://second.test' }))
        .resolves.toEqual({ url: 'https://second.test' })

      await expect(firstChild.closed).resolves.toBeUndefined()
      await secondChild.close()
    } finally {
      if (previousBridge === undefined) Reflect.deleteProperty(process.env, 'HYDRA_DESKTOP_BROWSER_BRIDGE')
      else process.env.HYDRA_DESKTOP_BROWSER_BRIDGE = previousBridge
      if (previousPort === undefined) Reflect.deleteProperty(process, 'parentPort')
      else Object.defineProperty(process, 'parentPort', previousPort)
    }
  })
})

describe('launchBrowser requests', () => {
  it('matches replies to requests by id', async () => {
    const { fake, child } = await started()
    const first = child.call('navigate', { url: 'https://example.test' })
    const second = child.call('click_element', { index: 3 })
    const a = await fake.next()
    const b = await fake.next()
    expect([a.method, b.method]).toEqual(['navigate', 'click_element'])
    // Answered out of order on purpose: only the id may decide the pairing.
    fake.say({ id: b.id, ok: true, result: { success: true, message: 'clicked' } })
    fake.say({ id: a.id, ok: true, result: { success: true, message: 'navigated' } })
    expect(await second).toEqual({ success: true, message: 'clicked' })
    expect(await first).toEqual({ success: true, message: 'navigated' })
  })

  it('surfaces a failure reported by the child', async () => {
    const { fake, child } = await started()
    const call = child.call('click_element', { index: 99 })
    const request = await fake.next()
    fake.say({ id: request.id, ok: false, error: 'no element with index 99' })
    await expect(call).rejects.toThrow('no element with index 99')
  })

  it('still fails when the child reports neither a result nor a reason', async () => {
    const { fake, child } = await started()
    const call = child.call('back', {})
    const request = await fake.next()
    fake.say({ id: request.id, ok: false })
    await expect(call).rejects.toThrow(/unknown failure/)
  })

  it('ignores unparseable output and replies to calls it never made', async () => {
    const { fake, child } = await started()
    fake.stdout.write('not json at all\n')
    fake.say({ id: 4_242, ok: true, result: null })
    fake.say({ ok: true, result: 'no id at all' })
    const call = child.call('get_browser_state', {})
    const request = await fake.next()
    fake.say({ id: request.id, ok: true, result: { url: 'about:blank' } })
    expect(await call).toEqual({ url: 'about:blank' })
  })

  it('awaits cancellation of a timed-out request before reusing the child', async () => {
    const { fake, child } = await started({ actionTimeoutMs: 20 })
    const call = child.call('get_browser_state', {})
    const request = await fake.next()
    const rejected = expect(call).rejects.toMatchObject({ code: 'BROWSER_TIMEOUT' })
    expect(await fake.next()).toMatchObject({ method: 'cancel_browser_call', args: { id: request.id } })
    fake.say({ id: request.id, ok: false, error: 'cancelled' })
    await rejected
    fake.say({ id: 1, ok: true, result: 'late' })
    const next = child.call('back', {})
    const nextRequest = await fake.next()
    fake.say({ id: nextRequest.id, ok: true, result: 'fine' })
    expect(await next).toBe('fine')
  })

  it('stops an unresponsive child before rejecting its timed-out request', async () => {
    vi.useFakeTimers()
    try {
      const { fake, child } = await started({ actionTimeoutMs: 20 })
      fake.exitOnStdinEnd = false
      const call = child.call('click_element', {})
      const rejected = expect(call).rejects.toMatchObject({ code: 'BROWSER_TIMEOUT' })
      const request = await fake.next()
      await vi.advanceTimersByTimeAsync(20)
      expect(await fake.next()).toMatchObject({ method: 'cancel_browser_call', args: { id: request.id } })
      expect(fake.killed).toBe(false)
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(fake.killed).toBe(true)
      await expect(child.call('get_browser_state', {})).rejects.toMatchObject({ code: 'BROWSER_GONE' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes an upstream PageAgent model request through the host callback', async () => {
    const onPageAgentLlm = vi.fn(async () => ({ choices: [] }))
    const { fake } = await started({ onPageAgentLlm })
    fake.say({ event: 'page-agent:llm', id: 71, tabId: 3, request: { messages: [] } })
    const response = await fake.next()
    expect(onPageAgentLlm).toHaveBeenCalledWith({ tabId: 3, request: { messages: [] } })
    expect(response).toEqual({
      method: 'page_agent_llm_response',
      args: { callId: 71, ok: true, result: { choices: [] } },
    })
  })

  it('keeps the browser call alive while chat answers and resumes its deadline', async () => {
    vi.useFakeTimers()
    try {
      const answer = Promise.withResolvers<'once'>()
      const onPermission = vi.fn(() => answer.promise)
      const { fake, child } = await started({ onPermission })
      const action = child.call('navigate', {})
      const request = await fake.next()
      fake.say({ event: 'browser:permission', id: 91, request: { kind: 'navigation', origin: 'https://example.test' } })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(onPermission).toHaveBeenCalledOnce()
      answer.resolve('once')
      expect(await fake.next()).toEqual({ method: 'browser_permission_response', args: { id: 91, choice: 'once' } })
      fake.say({ id: request.id, ok: true, result: 'loaded' })
      await expect(action).resolves.toBe('loaded')
      await child.close()
    } finally { vi.useRealTimers() }
  })

  it('denies missing or malformed permission bridges and cancels outstanding questions on exit', async () => {
    const { fake, child } = await started()
    fake.say({ event: 'browser:permission', id: 90, request: { kind: 'navigation', origin: 'https://example.test' } })
    expect((await fake.next()).args).toEqual({ id: 90 })
    await child.close()
    let signal: AbortSignal | undefined
    const answer = Promise.withResolvers<'always'>()
    const bridge = await started({ onPermission: (_request: unknown, pending: AbortSignal) => {
      signal = pending
      return answer.promise
    } })
    bridge.fake.say({ event: 'browser:permission', id: 91, request: { kind: 'navigation', origin: 'file:///secret' } })
    expect((await bridge.fake.next()).args).toEqual({ id: 91 })
    bridge.fake.say({ event: 'browser:permission', id: 92, request: { kind: 'media', origin: 'https://example.test' } })
    await vi.waitFor(() => { expect(signal).toBeDefined() })
    await bridge.child.close()
    expect(signal?.aborted).toBe(true)
    answer.resolve('always')
  })

  it('withdraws chat permissions when the calling action is cancelled', async () => {
    const answer = Promise.withResolvers<'always'>()
    const { fake, child } = await started({ onPermission: () => answer.promise })
    const controller = new AbortController()
    const action = child.call('navigate', {}, controller.signal)
    const rejected = expect(action).rejects.toThrow('stopped')
    const request = await fake.next()
    fake.say({ event: 'browser:permission', id: 1, request: { kind: 'navigation', origin: 'https://example.test' } })
    controller.abort(new Error('stopped'))
    expect(await fake.next()).toMatchObject({ method: 'cancel_browser_call', args: { id: request.id } })
    answer.resolve('always')
    expect((await fake.next()).args).toEqual({ id: 1 })
    fake.say({ id: request.id, ok: false, error: 'cancelled' })
    await rejected
    await child.close()
  })

  it('fails outstanding and later calls once the child is gone', async () => {
    const { fake, child } = await started()
    const outstanding = child.call('get_browser_state', {})
    await fake.next()
    fake.emit('exit')
    await expect(outstanding).rejects.toMatchObject({ code: 'BROWSER_GONE' })
    await expect(child.call('back', {})).rejects.toMatchObject({ code: 'BROWSER_GONE' })
    await child.closed
  })
})

describe('launchBrowser shutdown', () => {
  it('closes by ending the child stdin', async () => {
    const { fake, child } = await started()
    await child.close()
    expect(fake.killed).toBe(false)
  })

  it('kills a child that will not exit on its own', async () => {
    vi.useFakeTimers()
    try {
      const { fake, child } = await started()
      fake.exitOnStdinEnd = false
      const closing = child.close()
      await vi.advanceTimersByTimeAsync(5_000)
      await closing
      expect(fake.killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resolveElectronPath', () => {
  it('returns whatever the electron package resolves to', () => {
    expect(resolveElectronPath((() => '/somewhere/electron') as unknown as NodeJS.Require)).toBe('/somewhere/electron')
  })

  it('explains that the embedded browser is optional when electron is absent', () => {
    const missing = (() => {
      throw new Error('Cannot find module')
    }) as unknown as NodeJS.Require
    expect(() => resolveElectronPath(missing)).toThrow(BrowserError)
    expect(() => resolveElectronPath(missing)).toThrow(/optional `electron` dependency/)
  })
})
