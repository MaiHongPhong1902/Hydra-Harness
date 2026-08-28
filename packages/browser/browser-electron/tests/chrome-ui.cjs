'use strict'

const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { app, BrowserWindow, webContents } = require('electron')

let server
let finished = false
let deadline
let phase = 'starting'
const annotations = []
let resolveController
const controllerReady = new Promise(resolve => { resolveController = resolve })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(25)
  }
  throw new Error('timed out waiting for browser chrome')
}

function finish(ok, error) {
  if (finished) return
  finished = true
  clearTimeout(deadline)
  process.stdout.write(`${JSON.stringify({ event: 'chrome-ui-test', ok, error: error?.stack ?? error?.message })}\n`)
  server.close()
  app.exit(ok ? 0 : 1)
}

process.on('unhandledRejection', error => finish(false, error))
process.on('uncaughtException', error => finish(false, error))

server = createServer((request, response) => {
  const title = {
    '/one': 'One',
    '/two': 'Two',
    '/three': 'Three',
  }[request.url] ?? 'Missing'
  response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`)
})

server.listen(0, '127.0.0.1', () => {
  const config = JSON.parse(process.argv[2] ?? '{}')
  app.setPath('userData', config.userDataDir)
  globalThis.__BH_BROWSER_EMBED__ = {
    config: {
      ...config,
      annotationScreenshots: 'include',
      navigationPolicy: 'allow',
      downloadPolicy: 'allow',
    },
    send() {},
    onState() {},
    onAnnotation(annotation) { annotations.push(annotation) },
    register(controller) { resolveController(controller) },
  }
  require('../electron-app/main.cjs')
  deadline = setTimeout(() => finish(false, new Error(`driver stalled at ${phase}`)), 25_000)
  void (async () => {
    const controller = await controllerReady
    controller.setBounds({ x: 0, y: 0, width: 1024, height: 768, visible: true })
    BrowserWindow.getAllWindows()[0]?.showInactive()
    phase = 'finding chrome'
    const chrome = await waitFor(() => webContents.getAllWebContents().find(contents => contents.getURL().endsWith('/chrome.html')))
    const address = `http://127.0.0.1:${server.address().port}`
    const titles = { '/one': 'One', '/two': 'Two', '/three': 'Three' }
    const state = () => chrome.executeJavaScript(`({
      count: document.querySelectorAll('.tab-select').length,
      active: [...document.querySelectorAll('.tab-select')].find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent,
      url: document.getElementById('omnibox').value,
      history: [...document.querySelectorAll('#omnibox-history option')].map(option => ({ label: option.label, value: option.value })),
      forwardDisabled: document.getElementById('forward').disabled,
    })`)
    const navigate = async path => {
      phase = `navigating ${path}`
      await chrome.executeJavaScript(`
        document.getElementById('omnibox').value = ${JSON.stringify(`${address}${path}`)}
        document.getElementById('omnibox-form').requestSubmit()
      `)
      await waitFor(async () => {
        const current = await state()
        return current.url === `${address}${path}` && current.active === titles[path]
      })
    }
    const activePage = () => webContents.getAllWebContents()
      .find(contents => contents !== chrome && contents.getURL().startsWith(address))
    const startAnnotation = async () => {
      await chrome.executeJavaScript("document.getElementById('annotate').click()")
      return await waitFor(async () => {
        const page = activePage()
        if (page === undefined) return undefined
        return await page.executeJavaScript("Boolean(document.querySelector('#bh-browser-annotation-overlay'))")
          ? page : undefined
      })
    }
    const dragRegion = async (page, pointerId) => {
      await page.executeJavaScript(`
        (() => {
          const overlay = document.querySelector('#bh-browser-annotation-overlay')
          overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: ${pointerId}, button: 0, buttons: 1, clientX: 40, clientY: 100 }))
          overlay.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, isPrimary: true, pointerId: ${pointerId}, button: 0, buttons: 1, clientX: 200, clientY: 220 }))
          overlay.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerId: ${pointerId}, button: 0, buttons: 0, clientX: 200, clientY: 220 }))
        })()
      `)
    }
    const waitForAnnotationEnd = async () => {
      await waitFor(async () => await chrome.executeJavaScript(
        "document.getElementById('annotate').getAttribute('aria-pressed') !== 'true'",
      ))
    }
    const configureAnnotations = annotationScreenshots => controller.command('configure_browser', {
      annotationScreenshots,
      downloadDirectory: '',
      askWhereToSave: false,
      navigationPolicy: 'allow',
      downloadPolicy: 'allow',
    })

    phase = 'waiting for the initial tab'
    await waitFor(async () => (await state()).count === 1)
    await navigate('/one')
    phase = 'waiting for first tab title'
    await waitFor(async () => (await state()).history.some(entry => entry.label === 'One' && entry.value === `${address}/one`))

    phase = 'capturing an included region screenshot'
    await dragRegion(await startAnnotation(), 1)
    await waitFor(() => annotations.length === 1)
    await waitForAnnotationEnd()
    assert.equal(annotations[0].kind, 'browser-region')
    assert.deepEqual(annotations[0].rect, { x: 40, y: 100, width: 160, height: 120 })
    assert.equal(annotations[0].screenshot?.mediaType, 'image/png')
    assert.deepEqual(Buffer.from(annotations[0].screenshot.data, 'base64').subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    phase = 'omitting a disabled region screenshot'
    await configureAnnotations('never')
    await dragRegion(await startAnnotation(), 2)
    await waitFor(() => annotations.length === 2)
    await waitForAnnotationEnd()
    assert.equal(annotations[1].kind, 'browser-region')
    assert.equal(annotations[1].screenshot, undefined)

    phase = 'discarding a same-origin stale screenshot'
    await configureAnnotations('include')
    const stalePage = await startAnnotation()
    const originalCapturePage = stalePage.capturePage.bind(stalePage)
    let releaseCapture
    let captureStarted
    const started = new Promise(resolve => { captureStarted = resolve })
    const released = new Promise(resolve => { releaseCapture = resolve })
    stalePage.capturePage = async rect => {
      captureStarted()
      await released
      return await originalCapturePage(rect)
    }
    await dragRegion(stalePage, 3)
    await started
    await stalePage.loadURL(`${address}/two`)
    releaseCapture()
    await waitForAnnotationEnd()
    assert.equal(annotations.length, 2)
    stalePage.capturePage = originalCapturePage
    await navigate('/one')

    phase = 'adding a tab'
    await chrome.executeJavaScript("document.getElementById('new-tab').click()")
    await waitFor(async () => (await state()).count === 2)
    await navigate('/two')
    await navigate('/three')
    phase = 'going back'
    await chrome.executeJavaScript("document.getElementById('back').click()")
    await waitFor(async () => (await state()).active === 'Two' && !(await state()).forwardDisabled)
    phase = 'going forward'
    await chrome.executeJavaScript("document.getElementById('forward').click()")
    await waitFor(async () => (await state()).active === 'Three')
    phase = 'selecting the first tab'
    await chrome.executeJavaScript("document.querySelectorAll('.tab-select')[0].click()")
    await waitFor(async () => (await state()).active === 'One')
    phase = 'closing the first tab'
    await chrome.executeJavaScript("document.querySelectorAll('.tab-close')[0].click()")
    await waitFor(async () => (await state()).count === 1 && (await state()).active === 'Three')
    phase = 'closing the browser window'
    app.once('window-all-closed', () => finish(true))
    BrowserWindow.getAllWindows()[0]?.close()
  })().catch(error => finish(false, new Error(`${phase}: ${error.message}`)))
})
