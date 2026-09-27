/** Real Browser service requests and answers permissions through the assembled chat UI. */
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { BrowserChildProcess } from '@hydra1902/harness-browser-electron'
import type { SessionId } from '@hydra1902/harness-session/types'
import { settingsNamespace } from '@hydra1902/harness-settings'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../examples/acp-agent/tests/snapshots/browser-tool-turn/session.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./snapshots/browser-permission/ui.expected.md', import.meta.url))

const MEDIA_EXPECTED = fileURLToPath(new URL('./snapshots/browser-permission/media.expected.md', import.meta.url))

describe('browser permission in chat', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sessionId: SessionId
  const MODE = webSnapshotMode()

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, paceMs: 15, toolsMode: 'native' })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })
  it('answers a Browsing permission approval in chat', async () => {
    const service = scaffold.ctx.browsers
    await scaffold.ctx.settings.update(settingsNamespace('browser-electron'), {
      browserPermissions: { browsing: 'ask', downloads: 'ask', uploads: 'ask' },
    })
    const originalSpawn = service.spawnChild
    const events = new EventEmitter()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child: BrowserChildProcess = {
      stdin, stdout, stderr: new PassThrough(),
      once: (event, listener) => events.once(event, listener),
      kill: () => { events.emit('exit') },
    }
    createInterface({ input: stdin }).on('line', (line) => {
      const request = JSON.parse(line) as { id: number; method: string; args: { choice?: unknown } }
      if (request.method === 'get_browser_state') {
        stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: {
          url: 'https://shop.test/order', title: 'Order form', header: '', content: '', footer: '', tabs: [],
          tabId: 1, activeTabId: 1, settled: true, capturedAt: '2026-09-07T00:00:00.000Z',
        } })}\n`)
      } else stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { success: true, message: `${request.method} succeeded` } })}\n`)
    })
    stdin.on('finish', () => events.emit('exit'))
    service.spawnChild = () => {
      queueMicrotask(() => stdout.write('{"event":"ready"}\n'))
      return child
    }
    try {
      const settled = scaffold.whenTurnSettled(30_000)
      const input = page.locator('textarea').first()
      const prompt = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0]
      if (prompt === undefined) throw new Error('browser fixture is empty')
      await input.fill(prompt)
      await input.press('Enter')
      const composer = page.locator('[data-approval-key]')
      for (const action of ['browser_navigate', 'browser_type', 'browser_select_text', 'browser_click',
        'browser_find', 'browser_snapshot', 'browser_network_requests', 'browser_network_request']) {
        await composer.getByText(`Browser permissions: browsing. Action: ${action}.`).waitFor({ timeout: 10_000 })
        expect(await page.getByRole('dialog').count()).toBe(0)
        if (action === 'browser_navigate') {
          const snapshot = await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd)
          await compareOrRefreshGolden(EXPECTED, snapshot, MODE)
        }
        await composer.getByRole('button', { name: 'Allow once' }).click()
      }
      sessionId = await settled
      const owner = scaffold.ctx.agents.get(sessionId)
      if (owner === undefined) throw new Error('the conversation has no live agent')
      const results = owner.session.events.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(8)
      expect(results.filter(event => event.data.message.content[0].isError)).toEqual([])
      expect(scaffold.ctx.settings.get(settingsNamespace('browser-electron'))).toMatchObject({
        browserPermissions: { browsing: 'ask', downloads: 'ask', uploads: 'ask' },
      })
      await expect.poll(() => composer.count()).toBe(0)
    } finally {
      const owner = scaffold.ctx.agents.get(sessionId)
      if (owner !== undefined) await service.close(owner)
      if (originalSpawn === undefined) delete service.spawnChild
      else service.spawnChild = originalSpawn
    }
  }, 30_000)
  it.each([
    ['Allow once', 'once'], ['Always allow', 'always'], ['Block', 'block'],
    ['Skip this question', undefined], ['Custom answer', undefined],
  ])('answers a native media permission in chat: %s', async (selection, expected) => {
    const owner = scaffold.ctx.agents.get(sessionId)
    if (owner === undefined) throw new Error('the conversation has no live agent')
    await scaffold.ctx.settings.update(settingsNamespace('browser-electron'), {
      browserPermissions: { browsing: 'allow', downloads: 'ask', uploads: 'ask' },
    })
    const service = scaffold.ctx.browsers
    const originalSpawn = service.spawnChild
    const events = new EventEmitter()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let callId = 0
    let choice: unknown
    const child: BrowserChildProcess = {
      stdin, stdout, stderr: new PassThrough(),
      once: (event, listener) => events.once(event, listener),
      kill: () => { events.emit('exit') },
    }
    createInterface({ input: stdin }).on('line', (line) => {
      const request = JSON.parse(line) as { id: number; method: string; args: { choice?: unknown } }
      if (request.method === 'get_browser_state') {
        callId = request.id
        stdout.write(`${JSON.stringify({ event: 'browser:permission', id: 1, request: { kind: 'media', origin: 'https://vtv.vn' } })}\n`)
      } else if (request.method === 'browser_permission_response') {
        choice = request.args.choice
        stdout.write(`${JSON.stringify({ id: callId, ok: true, result: {
          url: 'https://vtv.vn', title: 'VTV', header: '', content: '', footer: '', tabs: [],
          tabId: 1, activeTabId: 1, settled: true, capturedAt: '2026-09-07T00:00:00.000Z',
        } })}\n`)
      }
    })
    stdin.on('finish', () => events.emit('exit'))
    service.spawnChild = () => {
      queueMicrotask(() => stdout.write('{"event":"ready"}\n'))
      return child
    }
    const action = service.perform(owner, { method: 'get_browser_state' })
    // Teardown may cancel the pending operation after an earlier UI assertion fails.
    void action.catch(() => {})
    try {
      const composer = page.locator('[data-question-key]')
      await composer.waitFor({ timeout: 10_000 })
      expect(await page.getByRole('dialog').count()).toBe(0)
      const snapshot = await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(MEDIA_EXPECTED, snapshot, MODE)
      if (selection === 'Skip this question') {
        await composer.getByRole('button', { name: selection }).click()
      } else {
        if (selection === 'Custom answer') await composer.getByRole('textbox').fill('yes')
        else await composer.getByRole('radio', { name: selection, exact: true }).click()
        await composer.getByRole('textbox').press('Enter')
      }
      await action
      expect(choice).toBe(expected)
      await expect.poll(() => composer.count()).toBe(0)
    } finally {
      await service.close(owner)
      await action.catch(() => {})
      if (originalSpawn === undefined) delete service.spawnChild
      else service.spawnChild = originalSpawn
    }
  }, 30_000)
})
