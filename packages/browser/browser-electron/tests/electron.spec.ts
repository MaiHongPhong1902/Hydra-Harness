import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchBrowser, resolveElectronPath } from '@bosch/bh-browser-electron'
import type { ActionResult, BrowserChild, BrowserState } from '@bosch/bh-browser-electron'

/**
 * The embedded browser is an optional capability: the `electron` binary may not
 * be installed, and a headless Linux host has no display for it even then.
 * Both are ordinary states of a working checkout, not failures.
 */
function browserRunnable(): boolean {
  if (process.platform === 'linux' && process.env.DISPLAY === undefined) return false
  try {
    return existsSync(resolveElectronPath())
  } catch {
    return false
  }
}

const FIXTURE_FILE = fileURLToPath(new URL('./fixtures/form.html', import.meta.url))
const NEXT_FIXTURE_FILE = fileURLToPath(new URL('./fixtures/next.html', import.meta.url))
const CHROME_UI_DRIVER = fileURLToPath(new URL('./chrome-ui.cjs', import.meta.url))

/** Drive the native chrome in a separate real Electron process. */
function runChromeUi(profile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveElectronPath(), [
      CHROME_UI_DRIVER,
      JSON.stringify({ userDataDir: profile, width: 1024, height: 768, show: false }),
    ])
    let stderr = ''
    let result: { ok: boolean; error?: string } | undefined
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`native chrome test timed out\n${stderr}`))
    }, 30_000)
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line) as { event?: string; ok?: boolean; error?: string }
        if (message.event === 'chrome-ui-test') {
          result = message.error === undefined
            ? { ok: message.ok === true }
            : { ok: message.ok === true, error: message.error }
          child.kill()
        }
      } catch {}
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (result?.ok) resolve()
      else reject(new Error(`native chrome test failed (exit ${code}): ${result?.error ?? stderr}`))
    })
  })
}

/**
 * Element index of the first rendered line mentioning `needle`.
 * @param content - the `content` block of a browser state.
 * @param needle - substring identifying the element, such as `id=submit`.
 * @returns the index PageController assigned to it.
 */
function indexOf(content: string, needle: string): number {
  const line = content.split('\n').find(candidate => candidate.includes(needle))
  if (line === undefined) throw new Error(`no element matching ${needle} in:\n${content}`)
  const match = /\[(\d+)]/.exec(line)
  if (match === null) throw new Error(`element line carries no index: ${line}`)
  return Number(match[1])
}

/** Wait only while the independently running BH-controlled PageAgent is active. */
async function pageAgentResult(child: BrowserChild): Promise<ActionResult> {
  const deadline = Date.now() + 10_000
  let result: ActionResult = { success: false, message: 'PageAgent status was not read.' }
  do {
    result = await child.call('page_agent_status', {}) as ActionResult
    if (!result.message.includes('running')) return result
    await new Promise(resolve => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  return result
}

describe.skipIf(!browserRunnable())('embedded browser against real Electron', () => {
  let profile: string
  let child: BrowserChild
  let fixtureServer: Server
  let fixture: string
  let nextFixture: string
  let spaStart: string
  let transientBody: string
  let cookieSet: string
  let cookieCheck: string
  let strictCspFixture: string

  beforeAll(async () => {
    fixtureServer = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (request.url === '/strict-csp') {
        response.setHeader('content-security-policy', "default-src 'self'; style-src 'self'")
        response.end('<!doctype html><title>Strict CSP</title><button id="target">Target</button>')
      } else if (request.url === '/sso-start') {
        response.end('<!doctype html><html><body><script>setTimeout(() => location.href = "/spa", 100)</script></body></html>')
      } else if (request.url === '/spa') {
        response.end('<!doctype html><html><body><main id="app"></main><script>setTimeout(() => { document.title = "Ready SPA"; document.querySelector("#app").innerHTML = "<button id=ready>Ready</button>" }, 600)</script></body></html>')
      } else if (request.url === '/transient-body') {
        response.end('<!doctype html><html><head><script>document.addEventListener("DOMContentLoaded", () => { document.body.remove(); setTimeout(() => { const body = document.createElement("body"); document.title = "Body restored"; body.innerHTML = "<button id=restored>Restored</button>"; document.documentElement.append(body) }, 600) })</script></head><body></body></html>')
      } else if (request.url === '/cookie-set') {
        response.setHeader('set-cookie', 'bh-browser-persistence=1; Path=/')
        response.end('<!doctype html><title>Cookie set</title>')
      } else if (request.url === '/cookie-check') {
        response.end(`<!doctype html><title>${request.headers.cookie?.includes('bh-browser-persistence=1') ? 'Cookie persisted' : 'Cookie missing'}</title>`)
      } else {
        response.end(readFileSync(request.url === '/next.html' ? NEXT_FIXTURE_FILE : FIXTURE_FILE))
      }
    })
    await new Promise<void>((resolve, reject) => {
      fixtureServer.once('error', reject)
      fixtureServer.listen(0, '127.0.0.1', resolve)
    })
    const address = fixtureServer.address() as AddressInfo
    fixture = `http://127.0.0.1:${address.port}/form.html`
    nextFixture = `http://127.0.0.1:${address.port}/next.html`
    spaStart = `http://127.0.0.1:${address.port}/sso-start`
    transientBody = `http://127.0.0.1:${address.port}/transient-body`
    cookieSet = `http://127.0.0.1:${address.port}/cookie-set`
    cookieCheck = `http://127.0.0.1:${address.port}/cookie-check`
    strictCspFixture = `http://127.0.0.1:${address.port}/strict-csp`
    profile = mkdtempSync(join(tmpdir(), 'bh-browser-'))
    child = await launchBrowser({
      userDataDir: profile,
      width: 1024,
      height: 768,
      // Headless for the suite; the harness runs it headed so the user watches.
      show: false,
      startupTimeoutMs: 60_000,
      actionTimeoutMs: 30_000,
      readinessTimeoutMs: 10_000,
      experimentalScriptExecution: true,
      onPageAgentLlm: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'bh-page-agent-smoke',
              type: 'function',
              function: {
                name: 'AgentOutput',
                arguments: JSON.stringify({ action: { done: { success: true, text: 'BH controlled bridge passed' } } }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
    })
  }, 90_000)

  afterAll(async () => {
    await child?.close()
    await new Promise<void>((resolve, reject) => {
      fixtureServer.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    rmSync(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
  })

  it('drives a real form through the vendored PageController', async () => {
    expect(await child.call('navigate', { url: fixture })).toMatchObject({ success: true })

    const before = await child.call('get_browser_state', {}) as BrowserState
    expect(before.title).toBe('Harness browser fixture')
    expect(before.content).toMatch(/\[\d+]<button/)
    const viewport = /Page info: \d+x(\d+)px viewport/.exec(before.header)
    expect(Number(viewport?.[1])).toBeLessThan(700)

    expect(await child.call('input_text', { index: indexOf(before.content, 'id=who'), text: 'Ada' }))
      .toMatchObject({ success: true })
    expect(await child.call('select_option', { index: indexOf(before.content, 'id=size'), text: 'Large' }))
      .toMatchObject({ success: true })
    expect(await child.call('click_element', { index: indexOf(before.content, 'id=submit') }))
      .toMatchObject({ success: true })

    const after = await child.call('get_browser_state', {}) as BrowserState
    expect(after.content).toContain('Ordered l for Ada')
  }, 60_000)

  it('returns a bounded page-element annotation for quick and interactive picking', async () => {
    await child.call('navigate', { url: fixture })
    const before = await child.call('get_browser_state', {}) as BrowserState
    const index = indexOf(before.content, 'id=submit')
    const point = await child.call('get_element_center', { index }) as { x: number; y: number }

    const quick = await child.call('annotate_element_at', point) as {
      kind: string
      index?: number
      preview: string
      url: string
    }
    expect(quick).toMatchObject({ kind: 'browser-element', index, url: fixture })
    expect(quick.preview).toContain('<button')

    const pending = child.call('annotate_element', {})
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const ready = await child.call('execute_javascript', {
        script: "return Boolean(document.querySelector('#bh-browser-annotation-overlay'))",
      }) as ActionResult
      if (ready.message.includes('true')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await child.call('execute_javascript', {
      script: `const overlay = document.querySelector('#bh-browser-annotation-overlay'); overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${point.x}, clientY: ${point.y} }))`,
    })
    const selected = await pending as { kind: string; index?: number; preview: string }
    expect(selected).toMatchObject({ kind: 'browser-element', index })
    expect(selected.preview).toContain('<button')
  }, 60_000)

  it('keeps the PageAgent panel out but prepares its visual mask', async () => {
    await child.call('navigate', { url: fixture })
    expect(await child.call('execute_javascript', {
      script: "return `${Boolean(document.querySelector('#page-agent-runtime_agent-panel'))}|${Boolean(document.querySelector('#page-agent-runtime_simulator-mask'))}`",
    })).toMatchObject({ success: true, message: expect.stringContaining('false|true') })
  }, 30_000)

  it('shows a styled virtual cursor for a BH indexed click', async () => {
    await child.call('navigate', { url: fixture })
    const before = await child.call('get_browser_state', {}) as BrowserState
    expect(await child.call('click_element', { index: indexOf(before.content, 'id=submit') }))
      .toMatchObject({ success: true })
    expect(await child.call('execute_javascript', {
      script: "const mask = document.querySelector('#page-agent-runtime_simulator-mask'); const cursor = mask?.lastElementChild; return `${getComputedStyle(mask).position}|${getComputedStyle(mask).display}|${cursor?.style.left.endsWith('px')}|${cursor?.style.left}`",
    })).toMatchObject({ success: true, message: expect.stringMatching(/fixed\|block\|true\|(?!512px)\d+(?:\.\d+)?px/) })
  }, 30_000)

  it('styles the mask when the page has a strict style CSP', async () => {
    await child.call('navigate', { url: strictCspFixture })
    expect(await child.call('execute_javascript', {
      script: "return getComputedStyle(document.querySelector('#page-agent-runtime_simulator-mask')).position",
    })).toMatchObject({ success: true, message: expect.stringContaining('fixed') })
  }, 30_000)

  it('runs upstream PageAgent only through BH control without its panel', async () => {
    await child.call('navigate', { url: fixture })
    expect(await child.call('page_agent_run', { task: 'Confirm the current page.' }))
      .toMatchObject({ success: true })
    expect(await pageAgentResult(child))
      .toMatchObject({ success: true, message: expect.stringContaining('completed. BH controlled bridge passed') })
    expect(await child.call('execute_javascript', {
      script: "return `${Boolean(document.querySelector('#page-agent-runtime_agent-panel'))}|${Boolean(document.querySelector('#page-agent-runtime_simulator-mask'))}`",
    })).toMatchObject({ success: true, message: expect.stringContaining('false|true') })
  }, 30_000)

  it('reports a failed action instead of throwing', async () => {
    expect(await child.call('click_element', { index: 9_999 })).toMatchObject({ success: false })
  }, 30_000)

  it('uploads a host file through an indexed file input without page JavaScript', async () => {
    await child.call('navigate', { url: fixture })
    const artifact = join(profile, 'artifact.json')
    writeFileSync(artifact, '{"name":"fixture"}')
    const before = await child.call('get_browser_state', {}) as BrowserState
    const uploaded = await child.call('upload_file', {
      index: indexOf(before.content, 'type=file'),
      filePath: artifact,
    }) as ActionResult
    expect(uploaded.success, uploaded.message).toBe(true)
    expect(uploaded.message).toContain('artifact.json')
    const after = await child.call('get_browser_state', {}) as BrowserState
    expect(after.content).toContain('Selected artifact.json')
  }, 30_000)

  it('navigates back to the page it left', async () => {
    await child.call('navigate', { url: 'about:blank' })
    expect(await child.call('back', {})).toMatchObject({ success: true })
    const state = await child.call('get_browser_state', {}) as BrowserState
    expect(state.url).toBe(fixture)
    expect(state.title).toBe('Harness browser fixture')
  }, 60_000)

  it('sends a key to the focused element', async () => {
    expect(await child.call('press', { key: 'Tab' })).toMatchObject({ success: true })
  }, 30_000)

  it('lets the page follow a navigation of its own', async () => {
    const before = await child.call('get_browser_state', {}) as BrowserState
    await expect(child.call('click_element', { index: indexOf(before.content, 'id=continue') }))
      .resolves.toMatchObject({ success: true })
    const after = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(after.url).toBe(nextFixture)
    expect(after.title).toBe('Next page')
  }, 30_000)

  it('follows a delayed redirect and SPA hydration before returning evidence', async () => {
    await child.call('navigate', { url: spaStart })
    const state = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(state.url).toMatch(/\/spa$/)
    expect(state.title).toBe('Ready SPA')
    expect(state.content).toContain('id=ready')
    expect(state.settled).toBe(true)
  }, 30_000)

  it('waits through a transient document with no body', async () => {
    await child.call('navigate', { url: transientBody })
    const state = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(state.title).toBe('Body restored')
    expect(state.content).toContain('id=restored')
    expect(state.settled).toBe(true)
  }, 30_000)

  it('loads the configured home page before the first browser state', async () => {
    const homeProfile = mkdtempSync(join(tmpdir(), 'bh-browser-home-'))
    let home: BrowserChild | undefined
    try {
      home = await launchBrowser({
        userDataDir: homeProfile,
        homeUrl: fixture,
        width: 1024,
        height: 768,
        show: false,
        startupTimeoutMs: 60_000,
        actionTimeoutMs: 30_000,
        readinessTimeoutMs: 10_000,
        experimentalScriptExecution: false,
      })
      const state = await home.call('get_browser_state', { waitForReady: true }) as BrowserState
      expect(state.url).toBe(fixture)
      expect(state.title).toBe('Harness browser fixture')
    } finally {
      await home?.close()
      rmSync(homeProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('keeps cookies when a later browser session reuses the same profile', async () => {
    const cookieProfile = mkdtempSync(join(tmpdir(), 'bh-browser-cookies-'))
    let first: BrowserChild | undefined
    let second: BrowserChild | undefined
    try {
      const options = {
        userDataDir: cookieProfile,
        width: 1024,
        height: 768,
        show: false,
        startupTimeoutMs: 60_000,
        actionTimeoutMs: 30_000,
        readinessTimeoutMs: 10_000,
        experimentalScriptExecution: false,
        persistSessionCookies: true,
      }
      first = await launchBrowser(options)
      await first.call('navigate', { url: cookieSet })
      await first.close()
      first = undefined

      second = await launchBrowser(options)
      await second.call('navigate', { url: cookieCheck })
      const state = await second.call('get_browser_state', { waitForReady: true }) as BrowserState
      expect(state.title).toBe('Cookie persisted')
    } finally {
      await first?.close()
      await second?.close()
      rmSync(cookieProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('targets multiple tabs without changing the selected tab', async () => {
    await child.call('navigate', { url: spaStart })
    await child.call('get_browser_state', { waitForReady: true })
    const state = await child.call('get_browser_state', {}) as BrowserState
    expect(await child.call('scroll_horizontally', { right: true, pixels: 100 }))
      .toMatchObject({ success: true })
    const currentTitle = await child.call('execute_javascript', { script: 'return document.title' }) as ActionResult
    expect(currentTitle.success).toBe(true)
    expect(currentTitle.message).toContain('Ready SPA')

    expect(await child.call('open_new_tab', { url: fixture })).toMatchObject({ success: true })
    const opened = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(opened.tabs).toHaveLength(2)
    expect(opened.activeTabId).not.toBe(state.activeTabId)
    const background = await child.call('get_browser_state', {
      tabId: state.tabId,
      waitForReady: true,
    }) as BrowserState
    expect(background).toMatchObject({
      tabId: state.tabId,
      activeTabId: opened.activeTabId,
      title: 'Ready SPA',
    })
    const [firstTitle, secondTitle] = await Promise.all([
      child.call('execute_javascript', { tabId: state.tabId, script: 'return document.title' }),
      child.call('execute_javascript', { tabId: opened.tabId, script: 'return document.title' }),
    ]) as [ActionResult, ActionResult]
    expect(firstTitle.message).toContain('Ready SPA')
    expect(secondTitle.message).toContain('Harness browser fixture')

    expect(await child.call('switch_to_tab', { tabId: state.tabId })).toMatchObject({ success: true })
    expect(await child.call('close_tab', { tabId: opened.tabId })).toMatchObject({ success: true })
    const closed = await child.call('get_browser_state', {}) as BrowserState
    expect(closed.tabs).toHaveLength(1)
  }, 60_000)

  it('adds, selects, closes, and navigates native tabs', async () => {
    const chromeProfile = mkdtempSync(join(tmpdir(), 'bh-browser-chrome-'))
    try {
      await runChromeUi(chromeProfile)
    } finally {
      rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)
})
