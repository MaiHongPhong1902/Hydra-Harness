/** Durable browser policy registration and the central control guard. */

import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import type { Agent } from '@hydra/harness-agent'
import { SettingsProvider } from '@hydra/harness-settings'
import type { SettingsNamespace } from '@hydra/harness-settings'
import { Context } from '@hydra/cordis'
import type { Fiber } from '@hydra/cordis'
import { describe, expect, it, vi } from 'vitest'
import BrowserSessionService, { BROWSER_SETTINGS_NAMESPACE } from '@hydra/harness-browser-electron'
import type { BrowserChildProcess } from '@hydra/harness-browser-electron'

/** Small writable provider used to exercise the real settings registration. */
class MemorySettings extends SettingsProvider {
  private stored: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored = { ...this.stored, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** Protocol stand-in used to observe revocation without starting Electron. */
class BrowserChildStub extends EventEmitter implements BrowserChildProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: { method: string; args: Record<string, unknown> }[] = []

  constructor() {
    super()
    createInterface({ input: this.stdin }).on('line', (line: string) => {
      const request = JSON.parse(line) as { id?: number; method: string; args: Record<string, unknown> }
      this.requests.push({ method: request.method, args: request.args })
      if (request.id === undefined) return
      const result = request.method === 'get_browser_state'
        ? {
          url: 'https://example.test', title: 'Example', header: '', content: '', footer: '',
          tabs: [
            { id: 1, url: 'https://example.test', title: 'One', status: 'complete', active: true },
            { id: 2, url: 'https://example.test/two', title: 'Two', status: 'complete', active: false },
          ],
          tabId: 1, activeTabId: 1, settled: true, capturedAt: '2026-08-26T00:00:00.000Z',
        }
        : { success: true, message: request.method }
      this.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
    })
    this.stdin.on('finish', () => this.emit('exit'))
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`))
  }

  kill(): void {
    this.emit('exit')
  }
}

async function boot(): Promise<{ ctx: Context; browserFiber: Fiber; settingsFiber: Fiber }> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const browserFiber = ctx.plugin(BrowserSessionService, { electronPath: '/fake/electron', show: false })
  await browserFiber.await()
  return { ctx, browserFiber, settingsFiber }
}

describe('browser-electron settings', () => {
  it('registers a durable control policy and blocks actions when disabled', async () => {
    const { ctx, browserFiber } = await boot()
    const descriptor = ctx.settings.describe().find(row => row.ns === BROWSER_SETTINGS_NAMESPACE)
    const defaults = {
      controlEnabled: true,
      webDestination: 'hydra',
      localDestination: 'hydra',
      annotationScreenshots: 'include',
      downloadDirectory: '',
      askWhereToSave: false,
      navigationPolicy: 'ask',
      downloadPolicy: 'ask',
      uploadPolicy: 'ask',
      historyAccessPolicy: 'ask',
      fullCdpAccess: false,
    }
    expect(descriptor?.value).toEqual(defaults)
    expect(descriptor?.base).toEqual(defaults)

    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { controlEnabled: false })

    await expect(ctx.browsers.perform({} as Agent, { method: 'get_browser_state' }))
      .rejects.toMatchObject({ code: 'BROWSER_DISABLED' })
    await browserFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('pushes changed native preferences into an open Electron controller', async () => {
    const { ctx, browserFiber } = await boot()
    const child = new BrowserChildStub()
    ctx.browsers.spawnChild = () => child
    await ctx.browsers.perform({ ctx } as Agent, { method: 'get_browser_state' })

    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, {
      webDestination: 'system',
      localDestination: 'system',
      annotationScreenshots: 'never',
      downloadDirectory: 'C:\\Downloads',
      askWhereToSave: true,
      navigationPolicy: 'block',
      downloadPolicy: 'allow',
      fullCdpAccess: true,
    })

    await vi.waitFor(() => {
      expect(child.requests.find(request => request.method === 'configure_browser')?.args).toEqual({
        webDestination: 'system',
        localDestination: 'system',
        annotationScreenshots: 'never',
        downloadDirectory: 'C:\\Downloads',
        askWhereToSave: true,
        navigationPolicy: 'block',
        downloadPolicy: 'allow',
        fullCdpAccess: true,
        fullCdpAccessAllowed: true,
      })
    })
    await browserFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('stops detached PageAgents and refuses their later model requests when disabled', async () => {
    const { ctx, browserFiber } = await boot()
    const child = new BrowserChildStub()
    ctx.browsers.spawnChild = () => child
    const owner = { ctx } as Agent
    await ctx.browsers.perform(owner, { method: 'page_agent_run', task: 'Inspect the page' })

    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { controlEnabled: false })
    await vi.waitFor(() => {
      expect(child.requests.filter(request => request.method === 'page_agent_stop').map(request => request.args))
        .toEqual([{ tabId: 1 }, { tabId: 2 }])
    })

    child.stdout.write(`${JSON.stringify({
      event: 'page-agent:llm', id: 91, tabId: 1, request: { messages: [] },
    })}\n`)
    await vi.waitFor(() => {
      const response = child.requests.find(request => request.method === 'page_agent_llm_response')?.args
      expect(response).toMatchObject({ callId: 91, ok: false })
      expect(response?.error).toContain('disabled')
    })

    await browserFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails closed while the settings provider reloads', async () => {
    const { ctx, browserFiber, settingsFiber } = await boot()
    await ctx.settings.update(BROWSER_SETTINGS_NAMESPACE, { controlEnabled: false })

    await settingsFiber.dispose()

    await expect(ctx.browsers.perform({} as Agent, { method: 'get_browser_state' }))
      .rejects.toMatchObject({ code: 'BROWSER_DISABLED' })
    await browserFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('releases its namespace with the browser service', async () => {
    const { ctx, browserFiber } = await boot()
    expect(ctx.settings.describe().some(row => row.ns === BROWSER_SETTINGS_NAMESPACE)).toBe(true)

    await browserFiber.dispose()

    expect(ctx.settings.describe().some(row => row.ns === BROWSER_SETTINGS_NAMESPACE)).toBe(false)
    await ctx.fiber.dispose()
  })
})
