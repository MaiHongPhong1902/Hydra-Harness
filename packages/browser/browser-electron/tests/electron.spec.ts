import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchBrowser, resolveElectronPath } from '@hydra1902/harness-browser-electron'
import type {
  ActionResult, BrowserCdpEventPage, BrowserChild, BrowserPageIdentity, BrowserScreenshot, BrowserState,
} from '@hydra1902/harness-browser-electron'

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
const HIDDEN_UPLOAD_FIXTURE_FILE = fileURLToPath(new URL('./fixtures/hidden-upload.html', import.meta.url))
const NEXT_FIXTURE_FILE = fileURLToPath(new URL('./fixtures/next.html', import.meta.url))
const AUTOFILL_FIXTURE_FILE = fileURLToPath(new URL('./fixtures/autofill.html', import.meta.url))
const SELECTION_FIXTURE_FILE = fileURLToPath(new URL('./fixtures/selection.html', import.meta.url))
const SPA_FIXTURE_FILE = fileURLToPath(new URL('./fixtures/spa.html', import.meta.url))
const POLICY_FIXTURE_FILE = fileURLToPath(new URL('./fixtures/policy.html', import.meta.url))
const CHROME_UI_DRIVER = fileURLToPath(new URL('./chrome-ui.cjs', import.meta.url))

/** Drive native chrome and await Electron shutdown before the caller removes its profile. */
function runChromeUi(profile: string, navigationOnly = false, driver = CHROME_UI_DRIVER): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveElectronPath(), [
      driver,
      JSON.stringify({ userDataDir: profile, width: 1024, height: 768, show: false, navigationOnly }),
    ])
    let stderr = ''
    let result: { ok: boolean; transcript?: unknown; error?: string } | undefined
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`native chrome test timed out\n${stderr}`))
    }, 45_000)
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line) as { event?: string; ok?: boolean; transcript?: unknown; error?: string }
        if (message.event === 'chrome-ui-test') {
          result = message.error === undefined
            ? { ok: message.ok === true, transcript: message.transcript }
            : { ok: message.ok === true, error: message.error }
        }
      } catch {}
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code === 0 && result?.ok) resolve(result.transcript)
      else reject(new Error(`native chrome test failed (exit ${code}): ${result?.error ?? ''}\n${stderr}`))
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
  let hiddenUploadFixture: string
  let uploadedArtifact = ''
  let nextFixture: string
  let spaStart: string
  let transientBody: string
  let cookieSet: string
  let cookieCheck: string
  let downloadUrl: string
  let mediaFrameHost: string
  let strictCspFixture: string
  let strictTrustedTypesFixture: string
  let autofillFixture: string
  let policyFixture: string
  let redirectFixture: string
  let mouseTestsFixture: string
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
      } else if (request.url === '/strict-trusted-types') {
        response.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; require-trusted-types-for 'script'; trusted-types default")
        response.end('<!doctype html><title>Trusted Types login</title><form><label for="email">Email</label><input id="email" type="text"><label for="password">Password</label><input id="password" type="password"><button id="login" type="submit">Log in</button></form>')
      } else if (request.url === '/autofill') {
        response.end(readFileSync(AUTOFILL_FIXTURE_FILE))
      } else if (request.url === '/sso-start') {
        response.end('<!doctype html><html><body><script>setTimeout(() => location.href = "/spa", 100)</script></body></html>')
      } else if (request.url === '/spa') {
        response.end(readFileSync(SPA_FIXTURE_FILE))
      } else if (request.url === '/transient-body') {
        response.end('<!doctype html><html><head><script>document.addEventListener("DOMContentLoaded", () => { document.body.remove(); setTimeout(() => { const body = document.createElement("body"); document.title = "Body restored"; body.innerHTML = "<button id=restored>Restored</button>"; document.documentElement.append(body) }, 600) })</script></head><body></body></html>')
      } else if (request.url === '/cookie-set') {
        response.setHeader('set-cookie', 'hydra-browser-persistence=1; Path=/')
        response.end('<!doctype html><title>Cookie set</title>')
      } else if (request.url === '/cookie-check') {
        response.end(`<!doctype html><title>${request.headers.cookie?.includes('hydra-browser-persistence=1') ? 'Cookie persisted' : 'Cookie missing'}</title>`)
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
        response.end(readFileSync(POLICY_FIXTURE_FILE, 'utf8').replaceAll('__CROSS_ORIGIN__', crossOrigin))
      } else if (request.url === '/redirect-cross') {
        response.writeHead(302, { location: `${crossOrigin}/next.html` }).end()
      } else if (request.url?.startsWith('/mouse-tests/')) {
        const mouseFile = fileURLToPath(new URL(`./fixtures${request.url}`, import.meta.url))
        if (existsSync(mouseFile)) response.end(readFileSync(mouseFile))
        else { response.writeHead(404); response.end('not found') }
      } else if (request.url === '/selection.html') {
        response.end(readFileSync(SELECTION_FIXTURE_FILE))
      } else if (request.url === '/hidden-upload.html') {
        response.end(readFileSync(HIDDEN_UPLOAD_FIXTURE_FILE))
      } else if (request.url === '/uploaded-artifact') {
        request.setEncoding('utf8')
        uploadedArtifact = ''
        request.on('data', (chunk: string) => { uploadedArtifact += chunk })
        request.on('end', () => { response.end('received') })
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
    hiddenUploadFixture = `http://127.0.0.1:${address.port}/hidden-upload.html`
    nextFixture = `http://127.0.0.1:${address.port}/next.html`
    mouseTestsFixture = `http://127.0.0.1:${address.port}/mouse-tests/index.html`
    spaStart = `http://127.0.0.1:${address.port}/sso-start`
    transientBody = `http://127.0.0.1:${address.port}/transient-body`
    cookieSet = `http://127.0.0.1:${address.port}/cookie-set`
    cookieCheck = `http://127.0.0.1:${address.port}/cookie-check`
    downloadUrl = `http://127.0.0.1:${address.port}/download`
    mediaFrameHost = `http://127.0.0.1:${address.port}/media-frame-host`
    strictCspFixture = `http://127.0.0.1:${address.port}/strict-csp`
    strictTrustedTypesFixture = `http://127.0.0.1:${address.port}/strict-trusted-types`
    autofillFixture = `http://127.0.0.1:${address.port}/autofill`
    policyFixture = `http://127.0.0.1:${address.port}/policy`
    redirectFixture = `http://127.0.0.1:${address.port}/redirect-cross`
    crossOrigin = `http://localhost:${address.port}`
    profile = mkdtempSync(join(tmpdir(), 'hydra-browser-'))
    child = await launchBrowser({
      userDataDir: profile,
      width: 1024,
      height: 768,
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
              id: 'hydra-page-agent-smoke',
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
    expect(before.content).toMatch(/textbox/)
    expect(before.content).not.toMatch(/\[\d+\]<input\b/)
    expect(before.content).toMatch(/\[\d+]<button/)
    const highlights = await child.call('execute_javascript', {
      script: "return getComputedStyle(document.getElementById('playwright-highlight-container')).display",
    }) as ActionResult
    expect(highlights.success).toBe(true)
    expect(highlights.message).toContain('none')
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

  it('reports settled same-document UI changes', async () => {
    await child.call('navigate', { url: fixture })
    await child.call('execute_javascript', { script: `
      document.body.innerHTML = '<div id="panel" role="dialog" aria-label="Details" hidden><button id="inside">Inside</button></div><button id="toggle" aria-expanded="false">Open</button><div id="decoration">Rotating</div>';
      document.querySelector('#toggle').onclick = () => {
        document.querySelector('#toggle').setAttribute('aria-expanded', 'true');
        document.querySelector('#panel').hidden = false;
        document.querySelector('#inside').focus();
      };
    ` })
    await child.call('get_browser_state', {})
    await child.call('click_element', { name: 'Open' })
    const state = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(state.url).toBe(fixture)
    expect(state.settled).toBe(true)
    expect(state.uiChanges?.shown.join('\n')).toContain('<dialog')
    expect(state.uiChanges?.shown.join('\n')).toContain('Inside')
    expect(state.uiChanges?.expanded.join('\n')).toContain('expanded="true"')
    expect(state.uiChanges?.focused).toContain('Inside')
    expect(state.uiChanges?.shown.join('\n')).not.toContain('id=toggle')
    await child.call('execute_javascript', { script: `
      document.querySelector('#panel').hidden = true;
      document.querySelector('#toggle').setAttribute('aria-expanded', 'false');
    ` })
    const hidden = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(hidden.uiChanges?.hidden.join('\n')).toContain('Inside')
    expect(hidden.uiChanges?.collapsed.join('\n')).toContain('id=toggle')
    await child.call('execute_javascript', { script: `
      globalThis.__decorationTimer = setInterval(() => document.querySelector('#decoration').classList.toggle('rotating'), 15);
    ` })
    try {
      const quiet = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
      expect(quiet.uiChanges).toBeUndefined()
    } finally {
      await child.call('execute_javascript', { script: 'clearInterval(globalThis.__decorationTimer)' })
    }
  }, 60_000)

  it('waits for accessibility text and drives native hover, drag, resize, and dialogs', async () => {
    await child.call('navigate', { url: fixture })
    await child.call('execute_javascript', { script: `
      document.body.innerHTML = '<button id="source" style="position:fixed;left:30px;top:30px">Source</button><button id="target" style="position:fixed;left:230px;top:30px">Target</button><button id="dialog" style="position:fixed;left:430px;top:30px">Prompt</button><output id="events"></output>';
      globalThis.__gestures = [];
      document.querySelector('#source').addEventListener('pointerenter', e => globalThis.__gestures.push('hover:' + e.isTrusted));
      document.addEventListener('pointermove', e => { if (e.buttons === 1) globalThis.__gestures.push('drag:' + e.isTrusted) });
      document.querySelector('#dialog').addEventListener('click', () => { document.querySelector('#events').textContent = 'Dialog result: ' + confirm('Continue?') });
      document.querySelector('#target').addEventListener('dragover', e => e.preventDefault());
      document.querySelector('#target').addEventListener('drop', e => { e.preventDefault(); document.querySelector('#events').textContent = 'Dropped: ' + e.dataTransfer.getData('text/plain') });
      setTimeout(() => document.querySelector('#events').textContent = 'Ready for gestures', 250);
      console.log('hydra-console-fixture');
    ` })
    expect(await child.call('wait_for', { seconds: 2, text: 'Ready for gestures' })).toMatchObject({ success: true })
    expect(await child.call('wait_for', { seconds: 0.1, textGone: 'Ready for gestures' })).toMatchObject({ success: false })
    const state = await child.call('get_browser_state', {}) as BrowserState
    const source = indexOf(state.content, 'id=source')
    const target = indexOf(state.content, 'id=target')
    const dialog = indexOf(state.content, 'id=dialog')
    expect(await child.call('hover_element', { index: source })).toMatchObject({ success: true })
    expect(await child.call('drag_element', { startIndex: source, endIndex: target })).toMatchObject({ success: true })
    const gestures = await child.call('execute_javascript', { script: 'return globalThis.__gestures.join(",")' }) as ActionResult
    expect(gestures.message).toContain('hover:true')
    expect(gestures.message).toContain('drag:true')
    expect(await child.call('drop', { index: target, filePaths: [], data: { 'text/plain': 'Hydra drop' } })).toMatchObject({ success: true })
    expect((await child.call('get_browser_state', {}) as BrowserState).content).toContain('Dropped: Hydra drop')
    await expect(child.call('drop', { index: target, filePaths: [join(profile, 'unapproved.txt')], data: {} })).rejects.toThrow('Host-bound')
    expect(await child.call('hover_element', { index: 999999 })).toMatchObject({ success: false })
    expect(await child.call('resize', { width: 800, height: 600 })).toMatchObject({ success: true })
    expect((await child.call('execute_javascript', { script: 'return innerWidth + "x" + innerHeight' }) as ActionResult).message).toContain('800x600')
    await expect(child.call('resize', { width: 0, height: 600 })).rejects.toThrow('viewport dimensions')
    expect((await child.call('console_messages', { level: 'info' }) as ActionResult).message).toContain('hydra-console-fixture')
    expect(await child.call('handle_dialog', { accept: false })).toMatchObject({ success: false })
    expect(await child.call('click_element', { index: dialog })).toMatchObject({ success: true })
    expect((await child.call('get_browser_state', {}) as BrowserState).footer).toContain('Continue?')
    expect(await child.call('handle_dialog', { accept: true, promptText: 'Ada' })).toMatchObject({ success: true })
    expect((await child.call('get_browser_state', {}) as BrowserState).content).toContain('Dialog result: true')
    const requests = await child.call('network_requests', { includeStatic: true }) as ActionResult
    expect(requests.message).toContain(fixture)
    const request = Number(/\[(\d+)\] GET .*form\.html/.exec(requests.message)?.[1])
    expect(await child.call('network_request', { index: request, part: 'response-body' })).toMatchObject({ success: true })
    expect(await child.call('network_request', { index: 999999 })).toMatchObject({ success: false })
    await child.call('execute_javascript', { script: `
      document.body.innerHTML = '<label>Agreement<input id="agreement" type="checkbox"></label><label>Choice<input id="choice" type="radio" name="choice"></label><input id="edit" aria-label="Editor" value="Replace me">';
    ` })
    expect(await child.call('fill_fields', { fields: [{ name: 'agreement', text: 'true' }, { name: 'choice', text: 'true' }] })).toMatchObject({ success: true })
    expect((await child.call('execute_javascript', { script: 'return document.querySelector("#agreement").checked && document.querySelector("#choice").checked' }) as ActionResult).message).toContain('true')
    expect(await child.call('fill_fields', { fields: [{ name: 'agreement', text: 'invalid' }] })).toMatchObject({ success: false })
    await child.call('click_element', { name: 'Editor' })
    await child.call('press', { key: 'ControlOrMeta+A' })
    await child.call('press', { key: 'Backspace' })
    expect((await child.call('execute_javascript', { script: 'return "Editor=" + document.querySelector("#edit").value + "!"' }) as ActionResult).message).toContain('Editor=!')
    await expect(child.call('press', { key: 'Invalid+A' })).rejects.toThrow('invalid keyboard chord')
  }, 30_000)

  it('delivers native pointer and mouse events for agent clicks', async () => {
    await child.call('navigate', { url: fixture })
    await child.call('execute_javascript', {
      script: "globalThis.__pointerEvents = []; for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) document.addEventListener(type, () => globalThis.__pointerEvents.push(type), { capture: true })",
    })
    const before = await child.call('get_browser_state', {}) as BrowserState
    await child.call('click_element', { index: indexOf(before.content, 'id=submit') })
    const events = await child.call('execute_javascript', { script: 'return globalThis.__pointerEvents' }) as ActionResult
    expect(events.message).toContain('pointerdown')
    expect(events.message).toContain('mousedown')
    expect(events.message).toContain('pointerup')
    expect(events.message).toContain('mouseup')
    expect(events.message).toContain('click')
  }, 60_000)

  it('waits for a disabled control and delivers a trusted Playwright click', async () => {
    await child.call('navigate', { url: fixture })
    await child.call('execute_javascript', { script: `
      document.body.innerHTML = '<button disabled aria-label="Deferred action">Wait</button>';
      const button = document.querySelector('button');
      button.addEventListener('click', event => button.setAttribute('data-trusted', String(event.isTrusted)));
      setTimeout(() => { button.disabled = false }, 500);
    ` })
    expect(await child.call('click_element', { name: 'Deferred action' })).toMatchObject({ success: true })
    const result = await child.call('execute_javascript', {
      script: "return document.querySelector('button').getAttribute('data-trusted')",
    }) as ActionResult
    expect(result.message).toContain('true')
  }, 60_000)

  it('cancels a pending native click without closing the tab or clicking later', async () => {
    await child.call('navigate', { url: fixture })
    await child.call('get_browser_state', { snapshot: {} })
    await child.call('execute_javascript', { script: `
      document.body.innerHTML = '<button id="deferred" disabled>Deferred</button><output>untouched</output>';
      document.querySelector('button').addEventListener('click', () => document.querySelector('output').textContent = 'clicked');
    ` })
    const controller = new AbortController()
    const pending = child.call('click_element', { target: '#deferred' }, controller.signal)
    const cancelled = expect(pending).rejects.toThrow('stop browser action')
    await new Promise(resolve => setTimeout(resolve, 150))
    controller.abort(new Error('stop browser action'))
    await cancelled
    await child.call('execute_javascript', { script: "document.querySelector('button').disabled = false" })
    const observed = await child.call('execute_javascript', {
      script: "await new Promise(resolve => setTimeout(resolve, 300)); return document.querySelector('output').textContent",
    }) as ActionResult
    expect(observed.message).toContain('untouched')
    expect(await child.call('click_element', { target: '#deferred' })).toMatchObject({ success: true })
    expect((await child.call('get_browser_state', {}) as BrowserState).content).toContain('clicked')
  }, 30_000)

  it.each([{}, { text: 'Never present on this page' }])('cancels a native wait: %j', async (condition) => {
    await child.call('navigate', { url: fixture })
    const controller = new AbortController()
    const pending = child.call('wait_for', { seconds: 10, ...condition }, controller.signal)
    const cancelled = expect(pending).rejects.toThrow('stop waiting')
    await new Promise(resolve => setTimeout(resolve, 150))
    controller.abort(new Error('stop waiting'))
    await cancelled
  }, 5_000)

  it('reads metadata without traversing the page or changing its numeric refs', async () => {
    await child.call('navigate', { url: fixture })
    await child.call('get_browser_state', {})
    await child.call('execute_javascript', { script: `
      document.querySelector('#who').setAttribute('data-hydra-a11y-ref', 'audit-ref');
      document.body.insertAdjacentHTML('afterbegin', '<button>New control</button>');
    ` })
    const metadata = await child.call('get_browser_state', { metadataOnly: true, waitForReady: true }) as BrowserState
    expect(metadata).toMatchObject({ url: fixture, content: '', settled: true })
    expect(metadata.tabs).toHaveLength(1)
    const ref = await child.call('execute_javascript', { script: "return document.querySelector('#who').getAttribute('data-hydra-a11y-ref')" }) as ActionResult
    expect(ref.message).toContain('audit-ref')
    expect((await child.call('get_browser_state', { waitForReady: true }) as BrowserState).content).toContain('New control')
    await expect(child.call('get_browser_state', { metadataOnly: 'yes' })).rejects.toThrow('metadataOnly')
  }, 30_000)

  it('resolves named Hydra actions, fills fields, and goes forward', async () => {
    expect(await child.call('navigate', { url: fixture })).toMatchObject({ success: true })
    const found = await child.call('find_element', { query: 'Requester' }) as ActionResult
    expect(found.success).toBe(true)
    expect(found.message).toMatch(/\[ref=e\d+]/)
    expect(await child.call('input_text', { name: 'who', text: 'Ada' })).toMatchObject({ success: true })
    expect(await child.call('fill_fields', {
      fields: [{ name: 'size', text: 'Large' }],
    })).toMatchObject({ success: true })
    expect(await child.call('click_element', { name: 'Place order' })).toMatchObject({ success: true })
    const after = await child.call('get_browser_state', {}) as BrowserState
    expect(after.content).toContain('Ordered l for Ada')
    expect(await child.call('click_element', { name: 'Continue' })).toMatchObject({ success: true })
    const next = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(next.url).toContain('next.html')
    expect(await child.call('back', {})).toMatchObject({ success: true })
    expect(await child.call('forward', {})).toMatchObject({ success: true })
    const forwarded = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(forwarded.url).toContain('next.html')
  }, 60_000)

  it('uses distilled refs and CSS selectors without confusing numeric indexes', async () => {
    await child.call('navigate', { url: fixture })
    const snapshot = await child.call('get_browser_state', { snapshot: { depth: 4 } }) as BrowserState
    expect(snapshot.content).toContain('[ref=e')
    const found = await child.call('find_element', { regex: '/textbox "Requester"/i' }) as ActionResult
    const ref = /textbox "Requester".*?\[ref=(e\d+)\]/u.exec(found.message)?.[1]
    expect(ref).toBeDefined()
    const typed = await child.call('input_text', { target: ref, text: 'Grace' }) as ActionResult
    expect(typed, typed.message).toMatchObject({ success: true })
    expect(await child.call('select_text', { target: ref })).toMatchObject({ success: true, selectedText: 'Grace' })
    expect(await child.call('fill_fields', { fields: [{ target: '#size', text: 'Large' }] })).toMatchObject({ success: true })
    const scoped = await child.call('get_browser_state', { snapshot: { target: '#submit', depth: 0, boxes: true } }) as BrowserState
    expect(scoped.content).toContain('Place order')
    expect(scoped.content).not.toContain('Requester')
    const clicked = await child.call('click_element', { target: '#submit' }) as ActionResult
    expect(clicked, clicked.message).toMatchObject({ success: true })
    expect((await child.call('get_browser_state', {}) as BrowserState).content).toContain('Ordered l for Grace')
    await child.call('execute_javascript', { script: "const secret = document.createElement('input'); secret.type = 'password'; secret.value = 'private-password-sentinel'; secret.setAttribute('aria-label', 'Secret: [ref=e999]'); secret.setAttribute('role', 'searchbox'); document.body.append(secret)" })
    const privateSnapshot = await child.call('get_browser_state', { snapshot: {} }) as BrowserState
    expect(privateSnapshot.content).not.toContain('private-password-sentinel')
    expect(privateSnapshot.content).toContain('[redacted]')
    expect(await child.call('find_element', { text: 'private-password-sentinel' })).toMatchObject({ success: false })
    expect(await child.call('find_element', { text: 'Definitely missing' })).toMatchObject({ success: false })
    await expect(child.call('find_element', { regex: '[' })).rejects.toThrow()
    await expect(child.call('get_browser_state', { snapshot: { depth: -1 } })).rejects.toThrow()
    const all = await child.call('network_requests', { includeStatic: true }) as ActionResult
    expect(all.message).toContain('form.html')
    const filtered = await child.call('network_requests', { includeStatic: true, filter: '/form\\.html/i' }) as ActionResult
    expect(filtered.message).toContain('form.html')
    expect(await child.call('network_requests', { includeStatic: true, filter: 'impossible-url' })).toMatchObject({ message: 'No retained network requests.' })
    await expect(child.call('network_requests', { filter: '[' })).rejects.toThrow()
  }, 60_000)

  it('keeps the preload channel ready across same-document navigation', async () => {
    await child.call('navigate', { url: fixture })
    const before = await child.call('get_browser_state', {}) as BrowserState
    await child.call('execute_javascript', {
      script: "history.pushState({}, '', location.pathname + '#same-document')",
    })
    const after = await child.call('get_browser_state', {}) as BrowserState
    expect(after.url).toContain('#same-document')
    expect(after.content).toContain('id=who')
    expect(after.tabId).toBe(before.tabId)
  }, 30_000)

  it('reads live page identity across same-document navigation', async () => {
    await child.call('navigate', { url: fixture })
    const before = await child.call('get_page_identity', {}) as BrowserPageIdentity
    expect(before).toMatchObject({
      url: fixture,
      title: 'Harness browser fixture',
      tabId: 1,
      activeTabId: 1,
      settled: true,
    })
    await child.call('execute_javascript', {
      script: "history.pushState({}, '', location.pathname + '#identity'); document.title = 'Identity SPA'",
    })

    await expect(child.call('get_page_identity', {})).resolves.toMatchObject({
      url: `${fixture}#identity`,
      title: 'Identity SPA',
      tabId: before.tabId,
      activeTabId: before.activeTabId,
      settled: true,
    })
  }, 30_000)

  it('rejects a click whose indexed target is covered by a popup', async () => {
    await child.call('navigate', { url: fixture })
    const before = await child.call('get_browser_state', {}) as BrowserState
    const index = indexOf(before.content, 'id=submit')
    await child.call('execute_javascript', {
      script: "const popup = document.createElement('div'); popup.id = 'popup'; popup.style = 'position:fixed; inset:0; z-index:999999'; document.body.append(popup)",
    })

    const result = await child.call('click_element', { index }) as ActionResult
    expect(result.success).toBe(false)
    expect(result.message).toContain('intercepts pointer events')
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
          script: "return Boolean(document.querySelector('#hydra-browser-annotation-overlay'))",
        }) as ActionResult
        return ready.message.includes('true')
      }, { timeout: 5_000 }).toBe(true)
      return { pending }
    }
    const pointer = (type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number, pointerId = 1) =>
      child.call('execute_javascript', {
        script: `const overlay = document.querySelector('#hydra-browser-annotation-overlay'); overlay.dispatchEvent(new PointerEvent('${type}', { bubbles: true, isPrimary: true, pointerId: ${pointerId}, button: 0, buttons: ${type === 'pointerup' || type === 'pointercancel' ? 0 : 1}, clientX: ${x}, clientY: ${y} }))`,
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
      script: `const overlay = document.querySelector('#hydra-browser-annotation-overlay'); overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${point.x}, clientY: ${point.y} }))`,
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

  it('retains activity received before the controller is ready and clears it when idle', async () => {
    const startupProfile = mkdtempSync(join(tmpdir(), 'hydra-mask-startup-'))
    try {
      const driver = fileURLToPath(new URL('./mask-startup.cjs', import.meta.url))
      await expect(runChromeUi(startupProfile, false, driver))
        .resolves.toEqual({ active: true, cursor: true, motion: true })
    } finally {
      rmSync(startupProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 45_000)

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

  it('keeps password entry working on pages enforcing Trusted Types', async () => {
    await child.call('navigate', { url: strictTrustedTypesFixture })
    const before = await child.call('get_browser_state', {}) as BrowserState
    expect(before.content).toContain('id=password')
    const password = indexOf(before.content, 'id=password')
    expect(await child.call('input_text', { index: password, text: 'fixture-password' }))
      .toMatchObject({ success: true })
    const value = await child.call('execute_javascript', {
      script: 'return document.getElementById("password")?.value',
    }) as ActionResult
    expect(value.success).toBe(true)
    expect(value.message).toContain('fixture-password')
  }, 30_000)

  it('moves the virtual cursor for real Playwright hover, click, and fill actions', async () => {
    await child.call('navigate', { url: new URL('/selection.html', fixture).href })
    for (const [method, name, mode] of [
      ['hover_element', 'multi', 'default'], ['input_text', 'input', 'ibeam'], ['click_element', 'multi', 'default'],
    ] as const) {
      await child.call('execute_javascript', {
        script: `globalThis.__cursorPoints = new Set();
          const cursor = document.querySelector('#page-agent-runtime_simulator-mask').lastElementChild;
          globalThis.__cursorObserver = new MutationObserver(() => globalThis.__cursorPoints.add(cursor.style.left + '|' + cursor.style.top));
          globalThis.__cursorObserver.observe(cursor, { attributes: true, attributeFilter: ['style'] });`,
      })
      const action = await child.call(method, { name, text: 'Ada' }) as ActionResult
      expect(action, action.message).toMatchObject({ success: true })
      try {
        await expect.poll(async () => {
          const result = await child.call('execute_javascript', {
            script: `const cursor = document.querySelector('#page-agent-runtime_simulator-mask').lastElementChild;
              const rect = document.getElementById('${name}').getBoundingClientRect();
              return [Math.abs(parseFloat(cursor.style.left) - rect.left - rect.width / 2) < 1,
                Math.abs(parseFloat(cursor.style.top) - rect.top - rect.height / 2) < 1,
                cursor.dataset.mode, globalThis.__cursorPoints.size > 2].join('|')`,
          }) as ActionResult
          expect(result.success).toBe(true)
          return result.message
        }, { timeout: 2_000 }).toContain(`true|true|${mode}|true`)
      } finally {
        await child.call('execute_javascript', { script: 'globalThis.__cursorObserver.disconnect()' })
      }
    }
  }, 30_000)

  it('drives virtual cursor scroll animation and hud', async () => {
    await child.call('navigate', { url: fixture })
    await child.call('get_browser_state', {})
    const scrollResult = await child.call('scroll', { down: true, numPages: 1 })
    expect(scrollResult).toMatchObject({ success: true })
    const hudResult = await child.call('execute_javascript', {
      script: `
        const hud = document.querySelector('#page-agent-runtime_simulator-mask [data-scroll-hud="true"]');
        return \`\${Boolean(hud)}|\${hud?.getAttribute('data-direction')}\`;
      `,
    }) as ActionResult
    expect(hudResult.success).toBe(true)
    expect(hudResult.message).toContain('true|down')
  }, 30_000)

  it('selects real text in the DOM with caret tracking and ibeam mode', async () => {
    await child.call('navigate', { url: fixture })
    await child.call('input_text', { name: 'who', text: 'Ada Lovelace' })
    const inputSelection = await child.call('select_text', { name: 'who' }) as { success: boolean; selectedText: string }
    expect(inputSelection).toMatchObject({ success: true, selectedText: 'Ada Lovelace' })
    const before = await child.call('get_browser_state', {}) as BrowserState
    const submitIndex = indexOf(before.content, 'id=submit')
    const selectResult = await child.call('select_text', { index: submitIndex }) as { success: boolean; selectedText: string }
    expect(selectResult.success).toBe(true)
    expect(selectResult.selectedText).toContain('Place order')
    const domSelection = await child.call('execute_javascript', {
      script: 'return window.getSelection()?.toString()',
    }) as ActionResult
    expect(domSelection.message).toContain('Place order')
  }, 30_000)

  it('completes partial DOM and input selections and keeps the cursor at the endpoint', async () => {
    await child.call('navigate', { url: new URL('/selection.html', fixture).href })
    const multi = await child.call('select_text', { name: 'multi' }) as { success: boolean; selectedText: string }
    expect(multi).toMatchObject({ success: true, selectedText: 'FIRST LINE\nSECOND LINE\nTHIRD LINE' })
    for (const id of ['input', 'textarea', 'text']) {
      const metrics = await child.call('execute_javascript', {
        script: `const element = document.getElementById('${id}');
          const context = document.createElement('canvas').getContext('2d');
          context.font = getComputedStyle(element).font;
          const rect = element.getBoundingClientRect();
          return JSON.stringify({ startX: rect.left + context.measureText('ABC').width,
            endX: rect.left + context.measureText('ABCDEFGHI').width, y: rect.top + 10 })`,
      }) as ActionResult
      const { startX, endX, y } = JSON.parse(metrics.message.split('Result: ')[1] ?? '') as { startX: number; endX: number; y: number }
      const result = await child.call('select_text', { startX, startY: y, endX, endY: y }) as { success: boolean; selectedText: string }
      expect(result).toMatchObject({ success: true, selectedText: 'DEFGHI' })
      const actual = await child.call('execute_javascript', {
        script: `await new Promise(resolve => setTimeout(resolve, 250));
          const element = document.getElementById('${id}');
          const text = element.value === undefined ? window.getSelection().toString() : element.value.slice(element.selectionStart, element.selectionEnd);
          const cursor = document.querySelector('#page-agent-runtime_simulator-mask').lastElementChild;
          return [text, Math.abs(parseFloat(cursor.style.left) - ${endX}) < 0.01,
            Math.abs(parseFloat(cursor.style.top) - ${y}) < 0.01, cursor.dataset.mode].join('|')`,
      }) as ActionResult
      expect(actual.message).toContain('DEFGHI|true|true|ibeam')
      const reverse = await child.call('select_text', { startX: endX, startY: y, endX: startX, endY: y }) as { selectedText: string }
      expect(reverse.selectedText).toBe('DEFGHI')
    }
    await child.call('input_text', { name: 'input', text: 'Mai Hồng Phong' })
    const wordMetrics = await child.call('execute_javascript', {
      script: `const element = document.getElementById('input');
        const style = getComputedStyle(element);
        const context = document.createElement('canvas').getContext('2d');
        context.font = [style.fontStyle, style.fontVariant, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
        const rect = element.getBoundingClientRect();
        const left = rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
        const startX = left + context.measureText('Mai ').width;
        const endX = startX + context.measureText('Hồng').width + 4;
        return JSON.stringify({ startX, endX, y: rect.top + rect.height / 2, caretX: left + context.measureText('Mai Hồng').width });`,
    }) as ActionResult
    const { startX, endX, y, caretX } = JSON.parse(wordMetrics.message.split('Result: ')[1] ?? '') as { startX: number; endX: number; y: number; caretX: number }
    const wordSelection = await child.call('select_text', { startX, startY: y, endX, endY: y }) as { success: boolean; selectedText: string }
    expect(wordSelection).toMatchObject({ success: true, selectedText: 'Hồng' })
    const wordCursor = await child.call('execute_javascript', {
      script: `const element = document.getElementById('input');
        const cursor = document.querySelector('#page-agent-runtime_simulator-mask').lastElementChild;
        return [element.selectionStart, element.selectionEnd, Math.abs(parseFloat(cursor.style.left) - ${caretX}) < 1.5].join('|')`,
    }) as ActionResult
    expect(wordCursor.message).toContain('4|8|true')
    const textarea = await child.call('select_text', { name: 'textarea' }) as { selectedText: string }
    expect(textarea.selectedText).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    for (const name of ['empty', 'password', 'number']) {
      expect(await child.call('select_text', { name })).toMatchObject({ success: false })
    }
    await expect(child.call('select_text', { startX: 30, endX: 100 })).rejects.toThrow('four finite')
    await expect(child.call('select_text', { startX: -1, startY: 40, endX: 100, endY: 40 })).rejects.toThrow('four finite')
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

  it('finds and uploads through a hidden file input and rejects a disabled target', async () => {
    await child.call('navigate', { url: hiddenUploadFixture })
    const artifact = join(profile, 'hidden-artifact.json')
    writeFileSync(artifact, '{"name":"hidden fixture"}')
    expect(await child.call('find_element', { query: 'Attach artifact' })).toMatchObject({ success: true })
    const before = await child.call('get_browser_state', {}) as BrowserState
    expect(before.content.match(/type=file/g)).toHaveLength(1)
    const target = await child.call('get_upload_target', {}) as { origin: string; tabId: number }
    const uploadArgs = {
      index: indexOf(before.content, 'id=hidden-artifact'),
      filePath: artifact,
      tabId: target.tabId,
      expectedOrigin: target.origin,
    }
    expect(await child.call('upload_file', uploadArgs)).toMatchObject({ success: true })
    let after = before
    await expect.poll(async () => {
      after = await child.call('get_browser_state', {}) as BrowserState
      return after.content
    }).toContain('Uploaded hidden-artifact.json')
    expect(uploadedArtifact).toBe('{"name":"hidden fixture"}')
    await child.call('execute_javascript', {
      script: "document.getElementById('hidden-artifact').disabled = true",
    })
    const disabled = await child.call('upload_file', {
      ...uploadArgs, index: indexOf(after.content, 'id=hidden-artifact'),
    }) as { success: boolean; message: string }
    expect(disabled.success).toBe(false)
    expect(disabled.message).toContain('enabled HTML file input')
  }, 30_000)

  it('retains tab-scoped CDP events and shares its debugger with approved uploads', async () => {
    const configure = (fullCdpAccess: boolean) => child.call('configure_browser', {
      webDestination: 'hydra',
      localDestination: 'hydra',
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
    expect(JSON.stringify(initial.events)).not.toContain('hydra-cdp-event')

    await child.call('cdp_command', {
      method: 'Runtime.enable', params: {}, expectedOrigin: target.origin, tabId: target.tabId,
    })
    await child.call('cdp_command', {
      method: 'Runtime.evaluate',
      params: { expression: "console.log('hydra-cdp-event')" },
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
    await child.call('navigate', { url: fixture })
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
    await child.call('navigate', { url: fixture })
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

  it('answers a home-page permission before the first browser state', async () => {
    const homeProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-home-'))
    const permissions: unknown[] = []
    let home: BrowserChild | undefined
    try {
      home = await launchBrowser({
        userDataDir: homeProfile,
        homeUrl: fixture,
        navigationPolicy: 'ask',
        onPermission: async (request) => {
          permissions.push(request)
          return 'once'
        },
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
      expect(permissions).toEqual([{ kind: 'navigation', origin: new URL(fixture).origin }])
    } finally {
      await home?.close()
      rmSync(homeProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('keeps cookies when a later browser session reuses the same profile', async () => {
    const cookieProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-cookies-'))
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
    const scopedProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-clear-scope-'))
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
    const boundedProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-sites-'))
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
    const mediaProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-media-'))
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
    const downloadProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-downloads-'))
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

  it('holds download bytes for approval and keeps navigation approval scoped to its URL', async () => {
    const permissionProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-permissions-'))
    let browser: BrowserChild | undefined
    const answer = Promise.withResolvers<'once' | undefined>()
    const asked = Promise.withResolvers<{ kind: string; filename?: string }>()
    try {
      browser = await launchBrowser({
        userDataDir: permissionProfile, width: 1024, height: 768, show: false,
        startupTimeoutMs: 60_000, actionTimeoutMs: 30_000, readinessTimeoutMs: 10_000,
        experimentalScriptExecution: false, downloadDirectory: permissionProfile,
        askWhereToSave: false, navigationPolicy: 'ask', downloadPolicy: 'ask',
        onPermission: (request) => { asked.resolve(request); return answer.promise },
      })
      await browser.call('navigate', { url: fixture, navigationApproved: true })
      const navigation = browser.call('navigate', { url: downloadUrl, navigationApproved: true }).catch(() => undefined)
      expect(await asked.promise).toEqual({ kind: 'download', origin: new URL(downloadUrl).origin, filename: 'browser-artifact.txt' })
      await new Promise(resolve => setTimeout(resolve, 800))
      const partials = readdirSync(permissionProfile).filter(name => name.startsWith('browser-artifact'))
      expect(partials.every(name => statSync(join(permissionProfile, name)).size === 0)).toBe(true)
      answer.resolve('once')
      await navigation
      await expect.poll(async () => {
        const downloads = await browser!.call('browser_downloads', {}) as Array<{ state: string }>
        return downloads[0]?.state
      }, { timeout: 10_000 }).toBe('completed')
      expect(readFileSync(join(permissionProfile, 'browser-artifact.txt'), 'utf8')).toBe('browser download fixture')
      await browser.call('configure_browser', {
        downloadDirectory: permissionProfile, askWhereToSave: false, navigationPolicy: 'allow', downloadPolicy: 'block',
      })
      await browser.call('navigate', { url: downloadUrl }).catch(() => undefined)
      await expect.poll(async () => {
        const downloads = await browser!.call('browser_downloads', {}) as Array<{ state: string }>
        return downloads[0]?.state
      }).toBe('cancelled')
      expect(readdirSync(permissionProfile).filter(name => name.startsWith('browser-artifact'))).toEqual(['browser-artifact.txt'])
      expect((await browser.call('get_browser_state', {}) as BrowserState).footer)
        .toContain('BROWSER_POLICY_DENIED: Download "browser-artifact.txt" was blocked by Browser permissions.')
      await browser.call('navigate', { url: fixture })
      expect((await browser.call('get_browser_state', {}) as BrowserState).footer).not.toContain('BROWSER_POLICY_DENIED')
    } finally {
      answer.resolve(undefined)
      await browser?.close()
      rmSync(permissionProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
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

    await expect(child.call('navigate', { url: policyFixture })).rejects.toThrow(/blocked/)
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
    const screenshotProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-screenshot-'))
    let visible: BrowserChild | undefined
    try {
      visible = await launchBrowser({
        userDataDir: screenshotProfile,
        width: 1024,
        height: 768,
        show: false,
        startupTimeoutMs: 60_000,
        actionTimeoutMs: 30_000,
        readinessTimeoutMs: 10_000,
        experimentalScriptExecution: true,
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
      const fullPage = await visible.call('browser_screenshot', { fullPage: true }) as BrowserScreenshot
      expect(fullPage.mode).toBe('full-page')
      expect(fullPage.height).toBeGreaterThanOrEqual(screenshot.height)
      const clipped = await visible.call('browser_screenshot', { clip: { x: 0, y: 0, width: 120, height: 80 } }) as BrowserScreenshot
      expect(clipped).toMatchObject({ mode: 'clip', clip: { x: 0, y: 0, width: 120, height: 80 } })
      await visible.call('execute_javascript_page', { script: `
        globalThis.__hydraPageWorld = 'ready';
        document.querySelector('#submit').addEventListener('click', () => { globalThis.__hydraPageWorld = 'clicked' });
      ` })
      expect((await visible.call('execute_javascript_page', { script: 'return globalThis.__hydraPageWorld' }) as ActionResult).message).toContain('ready')
      const rect = JSON.parse((await visible.call('execute_javascript_page', { script: 'const r = document.querySelector("#submit").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }' }) as ActionResult).message) as { x: number; y: number }
      await visible.call('click_at', rect)
      expect((await visible.call('execute_javascript_page', { script: 'return globalThis.__hydraPageWorld' }) as ActionResult).message).toContain('clicked')
      await expect(visible.call('browser_screenshot', { tabId: background.tabId }))
        .rejects.toThrow('browser_screenshot does not accept tabId')
    } finally {
      await visible?.close()
      rmSync(screenshotProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('keeps user browsing independent from agent navigation policy', async () => {
    const chromeProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-user-navigation-'))
    try {
      expect(await runChromeUi(chromeProfile, true)).toMatchInlineSnapshot(`
        [
          {
            "action": "search",
            "input": "googlr",
            "permissionRequests": 0,
            "title": "Search results",
            "url": "https://www.google.com/search?q=googlr",
          },
          {
            "action": "address",
            "permissionRequests": 0,
            "title": "One",
            "url": "<fixture>/one",
          },
          {
            "action": "user-redirect",
            "permissionRequests": 0,
            "url": "<other-origin>/redirect-target",
          },
          {
            "action": "user-click",
            "permissionRequests": 0,
            "title": "One",
          },
          {
            "action": "user-controls",
            "permissionRequests": 0,
            "title": "One",
          },
        ]
      `)
    } finally {
      rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('adds, selects, closes, and navigates native tabs', async () => {
    const chromeProfile = mkdtempSync(join(tmpdir(), 'hydra-browser-chrome-'))
    try {
      expect(await runChromeUi(chromeProfile)).toMatchInlineSnapshot(`
        [
          {
            "action": "search",
            "input": "googlr",
            "permissionRequests": 0,
            "title": "Search results",
            "url": "https://www.google.com/search?q=googlr",
          },
          {
            "action": "address",
            "permissionRequests": 0,
            "title": "One",
            "url": "<fixture>/one",
          },
        ]
      `)
    } finally {
      rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  }, 60_000)

  it('interacts with the mouse test suite and completes missions', async () => {
    await child.call('navigate', { url: mouseTestsFixture })
    const state = await child.call('get_browser_state', { waitForReady: true }) as BrowserState
    expect(state.content).toContain('Mouse Interaction Test Suite')

    const clickBtnIndex = indexOf(state.content, 'id=btnMissionClick')
    const clickResult = await child.call('click_element', { index: clickBtnIndex }) as ActionResult
    expect(clickResult.success).toBe(true)

    const textInputIndex = indexOf(state.content, 'id=missionTextInput')
    const inputResult = await child.call('input_text', { index: textInputIndex, text: 'Agent Active 2026' }) as ActionResult
    expect(inputResult.success).toBe(true)

    const missionCheck = await child.call('execute_javascript', {
      script: `
        return [
          document.getElementById('statusMission1')?.textContent,
          document.getElementById('statusMission6')?.textContent,
        ].join('|')
      `,
    }) as ActionResult
    expect(missionCheck.message).toContain('PASSED|PASSED')
  }, 30_000)
})
