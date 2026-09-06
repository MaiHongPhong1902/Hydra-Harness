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
import { launchBrowser, resolveElectronPath } from '@hydra/harness-browser-electron'
import type {
  ActionResult, BrowserCdpEventPage, BrowserChild, BrowserScreenshot, BrowserState,
} from '@hydra/harness-browser-electron'

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
    }, 45_000)
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

/** Wait only while the independently running Hydra-controlled PageAgent is active. */
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
  let downloadUrl: string
  let mediaFrameHost: string
  let strictCspFixture: string
  let autofillFixture: string
  let policyFixture: string
  let redirectFixture: string
  let crossOrigin: string
  let mediaFrameRequests = 0
  let holdMediaFrameReload = false
  let releaseMediaFrameReload: (() => void) | undefined

  beforeAll(async () => {
    fixtureServer = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (request.url === '/strict-csp') {
        response.setHeader('content-security-policy', "default-src 'self'; style-src 'self'")
        response.end('<!doctype html><title>Strict CSP</title><button id="target">Target</button>')
      } else if (request.url === '/autofill') {
        response.end('<!doctype html><title>Autofill fixture</title><form><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password" value="markup-password-secret"></form><form><input id="contact-name" autocomplete="name"><input id="implicit-city" name="city"></form>')
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
      } else if (request.url?.startsWith('/download')) {
        response.setHeader('content-disposition', 'attachment; filename="browser-artifact.txt"')
        response.flushHeaders()
        setTimeout(() => { response.end('browser download fixture') }, 500)
      } else if (request.url === '/media-frame-host') {
        response.end(`<!doctype html><title>Media host</title><output id="media-events"></output><script>addEventListener('message', event => { document.querySelector('#media-events').textContent += event.data + ',' })</script><iframe allow="camera; microphone" src="${crossOrigin}/media-frame"></iframe>`)
      } else if (request.url === '/media-frame') {
        mediaFrameRequests += 1
        const finish = () => {
          response.end('<!doctype html><title>Media frame</title><script>navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(stream => { globalThis.activeStream = stream; parent.postMessage("capture-live", "*") }, error => parent.postMessage(`capture-${error.name}`, "*"))</script>')
        }
        if (holdMediaFrameReload) releaseMediaFrameReload = finish
        else finish()
      } else if (request.url === '/policy') {
        response.end(`<!doctype html><title>Policy fixture</title><a id="cross" href="${crossOrigin}/next.html">Cross origin</a><a id="popup" href="${crossOrigin}/next.html" target="_blank">Popup</a>`)
      } else if (request.url === '/redirect-cross') {
        response.writeHead(302, { location: `${crossOrigin}/next.html` }).end()
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
    downloadUrl = `http://127.0.0.1:${address.port}/download`
    mediaFrameHost = `http://127.0.0.1:${address.port}/media-frame-host`
    strictCspFixture = `http://127.0.0.1:${address.port}/strict-csp`
    autofillFixture = `http://127.0.0.1:${address.port}/autofill`
    policyFixture = `http://127.0.0.1:${address.port}/policy`
    redirectFixture = `http://127.0.0.1:${address.port}/redirect-cross`
    crossOrigin = `http://localhost:${address.port}`
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
                arguments: JSON.stringify({ action: { done: { success: true, text: 'Hydra controlled bridge passed' } } }),
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

  it('rejects a click whose indexed target is covered by a popup', async () => {
    await child.call('navigate', { url: fixture })
    const before = await child.call('get_browser_state', {}) as BrowserState
    const index = indexOf(before.content, 'id=submit')
    await child.call('execute_javascript', {
      script: "const popup = document.createElement('div'); popup.id = 'popup'; popup.style = 'position:fixed; inset:0; z-index:999999'; document.body.append(popup)",
    })

    const result = await child.call('click_element', { index }) as ActionResult
    expect(result.success).toBe(false)
    expect(result.message).toContain('covered by <div>')
  }, 60_000)

  it('picks bounded page elements and regions and cancels interrupted selections', async () => {
    await child.call('navigate', { url: fixture })
    const before = await child.call('get_browser_state', {}) as BrowserState
    const index = indexOf(before.content, 'id=submit')
    const point = await child.call('get_element_center', { index }) as { x: number; y: number }
    const startPicker = async () => {
      const pending = child.call('annotate_element', {})
      await expect.poll(async () => {
        const ready = await child.call('execute_javascript', {
          script: "return Boolean(document.querySelector('#bh-browser-annotation-overlay'))",
        }) as ActionResult
        return ready.message.includes('true')
      }, { timeout: 5_000 }).toBe(true)
      return { pending }
    }
    const pointer = (type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number, pointerId = 1) =>
      child.call('execute_javascript', {
        script: `const overlay = document.querySelector('#bh-browser-annotation-overlay'); overlay.dispatchEvent(new PointerEvent('${type}', { bubbles: true, isPrimary: true, pointerId: ${pointerId}, button: 0, buttons: ${type === 'pointerup' || type === 'pointercancel' ? 0 : 1}, clientX: ${x}, clientY: ${y} }))`,
      })

    const quick = await child.call('annotate_element_at', point) as {
      kind: string
      index?: number
      preview: string
      url: string
    }
    expect(quick).toMatchObject({ kind: 'browser-element', index, url: fixture })
    expect(quick.preview).toContain('<button')

    const { pending } = await startPicker()
    await child.call('execute_javascript', {
      script: `const overlay = document.querySelector('#bh-browser-annotation-overlay'); overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${point.x}, clientY: ${point.y} }))`,
    })
    const selected = await pending as { kind: string; index?: number; preview: string }
    expect(selected).toMatchObject({ kind: 'browser-element', index })
    expect(selected.preview).toContain('<button')

    const { pending: regionPending } = await startPicker()
    await pointer('pointerdown', 40, 100)
    await pointer('pointermove', 200, 220)
    await pointer('pointerup', 200, 220)
    await expect(regionPending).resolves.toMatchObject({
      kind: 'browser-region',
      rect: { x: 40, y: 100, width: 160, height: 120 },
    })

    const { pending: tinyPending } = await startPicker()
    await pointer('pointerdown', point.x, point.y, 2)
    await pointer('pointerup', point.x + 2, point.y, 2)
    await expect(tinyPending).resolves.toMatchObject({ kind: 'browser-element', index })

    const { pending: escaped } = await startPicker()
    await child.call('execute_javascript', {
      script: "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
    })
    await expect(escaped).resolves.toBeUndefined()

    const { pending: cancelled } = await startPicker()
    await pointer('pointerdown', 40, 100, 3)
    await pointer('pointercancel', 60, 120, 3)
    await expect(cancelled).resolves.toBeUndefined()
  }, 60_000)

  it('keeps the PageAgent panel out but prepares its visual mask', async () => {
    await child.call('navigate', { url: fixture })
    const result = await child.call('execute_javascript', {
      script: "return `${Boolean(document.querySelector('#page-agent-runtime_agent-panel'))}|${Boolean(document.querySelector('#page-agent-runtime_simulator-mask'))}`",
    }) as ActionResult
    expect(result.success).toBe(true)
    expect(result.message).toContain('false|true')
  }, 30_000)

  it('keeps the native cursor visible beside a styled virtual cursor', async () => {
    await child.call('navigate', { url: fixture })
    const before = await child.call('get_browser_state', {}) as BrowserState
    expect(await child.call('click_element', { index: indexOf(before.content, 'id=submit') }))
      .toMatchObject({ success: true })
    const result = await child.call('execute_javascript', {
      script: "const mask = document.querySelector('#page-agent-runtime_simulator-mask'); const cursor = mask?.lastElementChild; const style = getComputedStyle(mask); return `${style.cursor}|${style.position}|${style.display}|${cursor?.style.left.endsWith('px')}|${cursor?.style.left}`",
    }) as ActionResult
    expect(result.success).toBe(true)
    expect(result.message).toMatch(/default\|fixed\|block\|true\|(?!512px)\d+(?:\.\d+)?px/)
  }, 30_000)

  it('styles the mask when the page has a strict style CSP', async () => {
    await child.call('navigate', { url: strictCspFixture })
    const result = await child.call('execute_javascript', {
      script: "return getComputedStyle(document.querySelector('#page-agent-runtime_simulator-mask')).position",
    }) as ActionResult
    expect(result.success).toBe(true)
    expect(result.message).toContain('fixed')
  }, 30_000)

  it('keeps autofill secrets encrypted, management-only, and out of Browser state', async () => {
    const status = await child.call('autofill_status', {}) as { available: boolean; reason?: string }
    await child.call('navigate', { url: autofillFixture })
    const state = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(state.content).toContain('value=[redacted]')
    expect(state.content).not.toContain('markup-password-secret')
    await expect(child.call('autofill_login', {
      expectedOrigin: new URL(autofillFixture).origin,
      username: 'protocol-user',
      password: 'protocol-secret',
    })).rejects.toThrow('unknown browser method: autofill_login')

    if (!status.available) {
      expect(status).toEqual({
        available: false,
        reason: 'Secure autofill storage is unavailable on this device.',
      })
      return
    }

    expect(status).toEqual({ available: true })
    const origin = new URL(autofillFixture).origin
    const login = await child.call('autofill_save_login', {
      origin,
      username: 'vault-user@example.test',
      password: 'vault-password-secret',
    }) as { id: string; origin: string; username: string }
    expect(login).toMatchObject({ origin, username: 'vault-user@example.test' })
    expect(login).not.toHaveProperty('password')
    const logins = await child.call('autofill_list_logins', {}) as Array<Record<string, unknown>>
    expect(logins).toEqual([login])
    expect(JSON.stringify(logins)).not.toContain('vault-password-secret')

    const contact = await child.call('autofill_save_contact', {
      label: 'Work contact',
      fields: { name: 'Vault Person', email: 'vault-person@example.test' },
    }) as { id: string; label: string }
    const contacts = await child.call('autofill_list_contacts', {}) as Array<Record<string, unknown>>
    expect(contacts).toEqual([contact])
    expect(contacts[0]).not.toHaveProperty('fields')
    expect(await child.call('autofill_get_contact', { id: contact.id })).toEqual({
      ...contact,
      fields: { name: 'Vault Person', email: 'vault-person@example.test' },
    })

    const stored = readFileSync(join(profile, 'browser-autofill.json'), 'utf8')
    for (const secret of ['vault-user@example.test', 'vault-password-secret', 'Vault Person']) {
      expect(stored).not.toContain(secret)
    }
    expect(await child.call('autofill_remove_login', { id: login.id })).toBe(true)
    expect(await child.call('autofill_remove_contact', { id: contact.id })).toBe(true)
  }, 30_000)

  it('runs upstream PageAgent only through Hydra control without its panel', async () => {
    await child.call('navigate', { url: fixture })
    expect(await child.call('page_agent_run', { task: 'Confirm the current page.' }))
      .toMatchObject({ success: true })
    const pageAgent = await pageAgentResult(child)
    expect(pageAgent.success).toBe(true)
    expect(pageAgent.message).toContain('completed. Hydra controlled bridge passed')
    const result = await child.call('execute_javascript', {
      script: "return `${Boolean(document.querySelector('#page-agent-runtime_agent-panel'))}|${Boolean(document.querySelector('#page-agent-runtime_simulator-mask'))}`",
    }) as ActionResult
    expect(result.success).toBe(true)
    expect(result.message).toContain('false|true')
  }, 30_000)

  it('reports a failed action instead of throwing', async () => {
    expect(await child.call('click_element', { index: 9_999 })).toMatchObject({ success: false })
  }, 30_000)

  it('uploads a host file through an indexed file input without page JavaScript', async () => {
    await child.call('navigate', { url: fixture })
    const artifact = join(profile, 'artifact.json')
    writeFileSync(artifact, '{"name":"fixture"}')
    const before = await child.call('get_browser_state', {}) as BrowserState
    const target = await child.call('get_upload_target', {}) as { origin: string; tabId: number }
    expect(await child.call('upload_file', {
      index: indexOf(before.content, 'type=file'),
      filePath: artifact,
      tabId: target.tabId,
      expectedOrigin: 'https://wrong.example',
    })).toMatchObject({ success: false })
    const uploaded = await child.call('upload_file', {
      index: indexOf(before.content, 'type=file'),
      filePath: artifact,
      tabId: target.tabId,
      expectedOrigin: target.origin,
    }) as ActionResult
    expect(uploaded.success, uploaded.message).toBe(true)
    expect(uploaded.message).toContain('artifact.json')
    const after = await child.call('get_browser_state', {}) as BrowserState
    expect(after.content).toContain('Selected artifact.json')
  }, 30_000)

  it('retains tab-scoped CDP events and shares its debugger with approved uploads', async () => {
    const configure = (fullCdpAccess: boolean) => child.call('configure_browser', {
      webDestination: 'bhagent',
      localDestination: 'bhagent',
      annotationScreenshots: 'include',
      downloadDirectory: '',
      askWhereToSave: false,
      navigationPolicy: 'allow',
      downloadPolicy: 'allow',
      fullCdpAccessAllowed: true,
      fullCdpAccess,
    })
    await configure(true)
    await child.call('navigate', { url: fixture })
    const target = await child.call('get_cdp_target', {}) as { origin: string; tabId: number }
    const initial = await child.call('cdp_read_events', {
      afterSequence: 0,
      limit: 100,
      method: 'Runtime.consoleAPICalled',
      expectedOrigin: target.origin,
      tabId: target.tabId,
    }) as BrowserCdpEventPage
    expect(initial.events).toEqual([])

    await child.call('cdp_command', {
      method: 'Runtime.enable', params: {}, expectedOrigin: target.origin, tabId: target.tabId,
    })
    await child.call('cdp_command', {
      method: 'Runtime.evaluate',
      params: { expression: "console.log('bh-cdp-event')" },
      expectedOrigin: target.origin,
      tabId: target.tabId,
    })
    let page: BrowserCdpEventPage = { events: [], nextSequence: initial.nextSequence }
    const deadline = Date.now() + 5_000
    do {
      page = await child.call('cdp_read_events', {
        afterSequence: initial.nextSequence,
        limit: 100,
        method: 'Runtime.consoleAPICalled',
        expectedOrigin: target.origin,
        tabId: target.tabId,
      }) as BrowserCdpEventPage
      if (page.events.length === 0) await new Promise(resolve => setTimeout(resolve, 25))
    } while (page.events.length === 0 && Date.now() < deadline)
    expect(page.events.length).toBeGreaterThan(0)
    expect(page.events.every(event => event.method === 'Runtime.consoleAPICalled')).toBe(true)
    expect(page.nextSequence).toBeGreaterThan(initial.nextSequence)
    expect(await child.call('cdp_read_events', {
      afterSequence: page.nextSequence,
      limit: 100,
      method: 'Runtime.consoleAPICalled',
      expectedOrigin: target.origin,
      tabId: target.tabId,
    })).toMatchObject({ events: [] })

    const artifact = join(profile, 'cdp-artifact.json')
    writeFileSync(artifact, '{"name":"cdp"}')
    const state = await child.call('get_browser_state', {}) as BrowserState
    const upload = await child.call('upload_file', {
      index: indexOf(state.content, 'type=file'),
      filePath: artifact,
      expectedOrigin: target.origin,
      tabId: target.tabId,
    }) as ActionResult
    expect(upload.success, upload.message).toBe(true)
    await expect(child.call('cdp_command', {
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' },
      expectedOrigin: target.origin,
      tabId: target.tabId,
    })).resolves.toBeTypeOf('object')

    await child.call('navigate', { url: `${crossOrigin}/next.html` })
    await expect(child.call('cdp_read_events', {
      afterSequence: page.nextSequence,
      limit: 100,
      expectedOrigin: target.origin,
      tabId: target.tabId,
    })).rejects.toThrow('CDP target changed')
    await configure(false)
    await expect(child.call('cdp_command', {
      method: 'Runtime.evaluate', params: {}, expectedOrigin: target.origin, tabId: target.tabId,
    })).rejects.toThrow('full browser CDP access is disabled')
    await child.call('navigate', { url: fixture })
  }, 60_000)

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

  it('manages native settings, history, downloads, site overrides, and clearing data', async () => {
    await child.call('configure_browser', {
      downloadDirectory: profile,
      askWhereToSave: false,
      navigationPolicy: 'allow',
      downloadPolicy: 'allow',
    })
    await child.call('navigate', { url: fixture })
    const history = await child.call('browser_history', {}) as Array<{ id: string; url: string }>
    expect(history.some(entry => entry.url === fixture)).toBe(true)
    await child.call('remove_browser_history', { id: history[0]?.id })

    await child.call('set_browser_site', { origin: 'https://example.test/path', access: 'block', media: 'block' })
    expect(await child.call('browser_sites', {})).toContainEqual({
      origin: 'https://example.test', access: 'block', media: 'block',
    })
    await child.call('remove_browser_site', { origin: 'https://example.test' })

    await child.call('navigate', { url: downloadUrl }).catch(() => undefined)
    let downloads: Array<{ id: string; filename: string; path: string; state: string }> = []
    await expect.poll(async () => {
      downloads = await child.call('browser_downloads', {}) as typeof downloads
      return downloads[0]?.state
    }, { timeout: 10_000 }).toBe('completed')
    expect(downloads[0]?.filename).toBe('browser-artifact.txt')
    expect(existsSync(downloads[0]?.path ?? '')).toBe(true)
    await child.call('remove_browser_download', { id: downloads[0]?.id })

    await child.call('clear_browser_data', {})
    expect(await child.call('browser_history', {})).toEqual([])
    expect(await child.call('browser_downloads', {})).toEqual([])
  }, 60_000)

  it('clears only the requested history or download scope', async () => {
    const scopedProfile = mkdtempSync(join(tmpdir(), 'bh-browser-clear-scope-'))
    let scoped: BrowserChild | undefined
    try {
      writeFileSync(join(scopedProfile, 'browser-management.json'), JSON.stringify({
        version: 1,
        history: [{
          id: 'history-1',
          url: fixture,
          title: 'Fixture history',
          visitedAt: '2026-08-27T00:00:00.000Z',
        }],
        downloads: [{
          id: 'download-1',
          url: fixture,
          filename: 'fixture.txt',
          path: join(scopedProfile, 'fixture.txt'),
          state: 'completed',
          startedAt: '2026-08-27T00:00:00.000Z',
        }],
        sites: {},
      }))
      scoped = await launchBrowser({
        userDataDir: scopedProfile,
        width: 1024,
        height: 768,
        show: false,
        startupTimeoutMs: 60_000,
        actionTimeoutMs: 30_000,
        readinessTimeoutMs: 10_000,
        experimentalScriptExecution: false,
      })

      await scoped.call('clear_browser_data', { scope: 'history' })
      expect(await scoped.call('browser_history', {})).toEqual([])
      expect(await scoped.call('browser_downloads', {})).toHaveLength(1)

      await scoped.call('clear_browser_data', { scope: 'downloads' })
      expect(await scoped.call('browser_history', {})).toEqual([])
      expect(await scoped.call('browser_downloads', {})).toEqual([])
      await expect(scoped.call('clear_browser_data', { scope: 'unknown' })).rejects
        .toThrow('clear data scope must be all, history, site-data, cache, or downloads')
    } finally {
      await scoped?.close()
      rmSync(scopedProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('keeps site overrides bounded while allowing updates at the limit', async () => {
    const boundedProfile = mkdtempSync(join(tmpdir(), 'bh-browser-sites-'))
    let bounded: BrowserChild | undefined
    try {
      const sites = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
        `https://site-${index}.test`, { access: 'allow', media: 'block' },
      ]))
      writeFileSync(join(boundedProfile, 'browser-management.json'), JSON.stringify({
        version: 1, history: [], downloads: [], sites,
      }))
      bounded = await launchBrowser({
        userDataDir: boundedProfile,
        width: 1024,
        height: 768,
        show: false,
        startupTimeoutMs: 60_000,
        actionTimeoutMs: 30_000,
        readinessTimeoutMs: 10_000,
        experimentalScriptExecution: false,
      })

      expect(await bounded.call('browser_sites', {})).toHaveLength(500)
      await expect(bounded.call('set_browser_site', {
        origin: 'https://overflow.test', access: 'allow', media: 'block',
      })).rejects.toThrow('site override limit of 500 reached')
      expect(await bounded.call('browser_sites', {})).toHaveLength(500)

      await bounded.call('set_browser_site', {
        origin: 'https://site-0.test/path', access: 'block', media: 'allow',
      })
      expect(await bounded.call('browser_sites', {})).toContainEqual({
        origin: 'https://site-0.test', access: 'block', media: 'allow',
      })
    } finally {
      await bounded?.close()
      rmSync(boundedProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('enforces stored navigation blocks and revokes media before the mutation returns', async () => {
    const mediaProfile = mkdtempSync(join(tmpdir(), 'bh-browser-media-'))
    let media: BrowserChild | undefined
    try {
      media = await launchBrowser({
        userDataDir: mediaProfile,
        width: 1024,
        height: 768,
        show: false,
        startupTimeoutMs: 60_000,
        actionTimeoutMs: 30_000,
        readinessTimeoutMs: 10_000,
        experimentalScriptExecution: true,
        navigationPolicy: 'allow',
        downloadPolicy: 'allow',
        spawnChild: (command, args) => spawn(command, [...args, '--use-fake-device-for-media-stream']),
      })
      mediaFrameRequests = 0
      await media.call('set_browser_site', { origin: crossOrigin, access: 'allow', media: 'allow' })
      await media.call('navigate', { url: mediaFrameHost })
      await expect.poll(async () => {
        const result = await media!.call('execute_javascript', {
          script: 'return document.querySelector("#media-events")?.textContent ?? ""',
        }) as ActionResult
        return result.message
      }, { timeout: 10_000 }).toContain('capture-live')

      holdMediaFrameReload = true
      let mutationSettled = false
      const mutation = media.call('set_browser_site', {
        origin: crossOrigin, access: 'allow', media: 'block',
      }).finally(() => { mutationSettled = true })
      await expect.poll(() => mediaFrameRequests, { timeout: 10_000 }).toBe(2)
      expect(mutationSettled).toBe(false)
      holdMediaFrameReload = false
      releaseMediaFrameReload?.()
      releaseMediaFrameReload = undefined
      await mutation
      expect((await media.call('get_browser_state', {}) as BrowserState).url).toBe(mediaFrameHost)
      await expect.poll(async () => {
        const result = await media!.call('execute_javascript', {
          script: 'return document.querySelector("#media-events")?.textContent ?? ""',
        }) as ActionResult
        return result.message
      }, { timeout: 10_000 }).toContain('capture-NotAllowedError')
      expect(await media.call('browser_sites', {})).toContainEqual({
        origin: crossOrigin, access: 'allow', media: 'block',
      })

      const origin = new URL(mediaFrameHost).origin
      await media.call('set_browser_site', { origin, access: 'block', media: 'block' })
      await expect(media.call('navigate', { url: nextFixture })).rejects.toThrow(/blocked/)
      await expect(media.call('reload', {})).rejects.toThrow(/blocked/)

      await media.call('remove_browser_site', { origin })
      await media.call('navigate', { url: fixture })
      await media.call('navigate', { url: `${crossOrigin}/next.html` })
      await media.call('navigate', { url: nextFixture })
      await media.call('back', {})
      const unblockedUrl = (await media.call('get_browser_state', {}) as BrowserState).url
      await media.call('set_browser_site', { origin, access: 'block', media: 'block' })
      await expect(media.call('back', {})).rejects.toThrow(/blocked/)
      await expect(media.call('forward', {})).rejects.toThrow(/blocked/)
      expect((await media.call('get_browser_state', {}) as BrowserState).url).toBe(unblockedUrl)
    } finally {
      holdMediaFrameReload = false
      releaseMediaFrameReload?.()
      releaseMediaFrameReload = undefined
      await media?.close()
      rmSync(mediaProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('reserves distinct paths for concurrent same-name downloads', async () => {
    const downloadProfile = mkdtempSync(join(tmpdir(), 'bh-browser-downloads-'))
    let downloadsChild: BrowserChild | undefined
    try {
      downloadsChild = await launchBrowser({
        userDataDir: downloadProfile,
        width: 1024,
        height: 768,
        show: false,
        startupTimeoutMs: 60_000,
        actionTimeoutMs: 30_000,
        readinessTimeoutMs: 10_000,
        experimentalScriptExecution: false,
        downloadDirectory: downloadProfile,
        askWhereToSave: false,
        navigationPolicy: 'allow',
        downloadPolicy: 'allow',
      })
      await Promise.all([
        downloadsChild.call('open_new_tab', { url: `${downloadUrl}?first` }).catch(() => undefined),
        downloadsChild.call('open_new_tab', { url: `${downloadUrl}?second` }).catch(() => undefined),
      ])
      let downloads: Array<{ filename: string; path: string; state: string }> = []
      await expect.poll(async () => {
        downloads = await downloadsChild!.call('browser_downloads', {}) as typeof downloads
        return downloads.filter(entry => entry.state === 'completed').length
      }, { timeout: 10_000 }).toBe(2)
      expect(downloads.map(entry => entry.filename)).toEqual(['browser-artifact.txt', 'browser-artifact.txt'])
      expect(new Set(downloads.map(entry => entry.path)).size).toBe(2)
      expect(downloads.map(entry => readFileSync(entry.path, 'utf8')))
        .toEqual(['browser download fixture', 'browser download fixture'])
    } finally {
      await downloadsChild?.close()
      rmSync(downloadProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('blocks explicit, redirected, clicked, and popup cross-origin navigation', async () => {
    await child.call('configure_browser', {
      downloadDirectory: profile,
      askWhereToSave: false,
      navigationPolicy: 'allow',
      downloadPolicy: 'allow',
    })
    await child.call('navigate', { url: policyFixture })
    const page = await child.call('get_browser_state', {}) as BrowserState
    const tabCount = page.tabs.length
    await child.call('configure_browser', {
      downloadDirectory: profile,
      askWhereToSave: false,
      navigationPolicy: 'block',
      downloadPolicy: 'allow',
    })

    await expect(child.call('navigate', { url: `${crossOrigin}/next.html` })).rejects.toThrow(/blocked/)
    await expect(child.call('open_new_tab', { url: `${crossOrigin}/next.html` })).rejects.toThrow(/blocked/)
    await expect(child.call('navigate', { url: redirectFixture })).rejects.toThrow()

    await child.call('navigate', { url: policyFixture })
    const links = await child.call('get_browser_state', {}) as BrowserState
    await child.call('click_element', { index: indexOf(links.content, 'id=cross') })
    expect((await child.call('get_browser_state', {}) as BrowserState).url).toBe(policyFixture)
    await child.call('click_element', { index: indexOf(links.content, 'id=popup') })
    await expect.poll(async () => (await child.call('get_browser_state', {}) as BrowserState).tabs.length)
      .toBe(tabCount)

    await child.call('configure_browser', {
      downloadDirectory: profile,
      askWhereToSave: false,
      navigationPolicy: 'allow',
      downloadPolicy: 'allow',
    })
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

  it('captures only the selected visible tab as a bounded PNG', async () => {
    const screenshotProfile = mkdtempSync(join(tmpdir(), 'bh-browser-screenshot-'))
    let visible: BrowserChild | undefined
    try {
      visible = await launchBrowser({
        userDataDir: screenshotProfile,
        width: 1024,
        height: 768,
        show: true,
        startupTimeoutMs: 60_000,
        actionTimeoutMs: 30_000,
        readinessTimeoutMs: 10_000,
        experimentalScriptExecution: false,
      })
      await visible.call('navigate', { url: spaStart })
      const background = await visible.call('get_browser_state', { waitForReady: true }) as BrowserState
      await visible.call('open_new_tab', { url: fixture })
      const selected = await visible.call('get_browser_state', { waitForReady: true }) as BrowserState

      const screenshot = await visible.call('browser_screenshot', {}) as BrowserScreenshot
      const png = Buffer.from(screenshot.data, 'base64')
      expect(screenshot).toMatchObject({
        mediaType: 'image/png',
        bytes: png.length,
        tabId: selected.activeTabId,
        url: fixture,
        title: 'Harness browser fixture',
      })
      expect(screenshot.tabId).not.toBe(background.tabId)
      expect([screenshot.width, screenshot.height].every(edge => edge > 0 && edge <= 2_000)).toBe(true)
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      await expect(visible.call('browser_screenshot', { tabId: background.tabId }))
        .rejects.toThrow('browser_screenshot does not accept tabId')
    } finally {
      await visible?.close()
      rmSync(screenshotProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
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
