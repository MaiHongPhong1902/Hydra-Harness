'use strict'

const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { app, BrowserWindow, webContents } = require('electron')

let server
let finished = false
let deadline
let phase = 'starting'
const annotations = []
const permissions = []
const requests = []
let opened = 0
let closed = 0
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
  const received = { host: request.headers.host, url: request.url, method: request.method, body: '' }
  requests.push(received)
  request.on('data', chunk => { received.body += chunk })
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
  globalThis.__HYDRA_BROWSER_EMBED__ = {
    config: {
      ...config,
      annotationScreenshots: 'include',
      navigationPolicy: 'allow',
      downloadPolicy: 'allow',
    },
    send(message) { if (message.event === 'browser:permission') permissions.push(message) },
    onState() {},
    onAnnotation(annotation) { annotations.push(annotation) },
    openBrowser() { opened += 1 },
    closeBrowser() { closed += 1 },
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
      activity: document.getElementById('status').textContent,
      theme: document.documentElement.dataset.theme,
      loadingHidden: document.getElementById('loading').hidden,
      secureHidden: document.getElementById('secure').hidden,
    })`)
    const chromePalette = () => chrome.executeJavaScript(`(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        scheme: style.colorScheme,
        shell: style.getPropertyValue('--chrome-shell').trim(),
        tabstrip: style.getPropertyValue('--chrome-tabstrip').trim(),
        surface: style.getPropertyValue('--chrome-surface').trim(),
        text: style.getPropertyValue('--chrome-text').trim(),
        muted: style.getPropertyValue('--chrome-muted').trim(),
        hover: style.getPropertyValue('--chrome-hover').trim(),
        border: style.getPropertyValue('--chrome-border').trim(),
        accent: style.getPropertyValue('--chrome-accent').trim(),
        accentText: style.getPropertyValue('--chrome-accent-text').trim(),
        omnibox: style.getPropertyValue('--chrome-omnibox').trim(),
        status: style.getPropertyValue('--chrome-status').trim(),
      }
    })()`)
    const navigate = async path => {
      phase = `navigating ${path}`
      await chrome.executeJavaScript(`
        document.getElementById('omnibox').value = ${JSON.stringify(`${address}${path}`)}
        document.getElementById('omnibox-form').requestSubmit()
      `)
      await waitFor(async () => {
        const current = await state()
        return current.url === `${address}${path}` && current.active === titles[path]
      }).catch(async error => {
        let diagnostic
        try { diagnostic = await state() } catch (stateError) { diagnostic = `state read failed: ${stateError.message}` }
        throw new Error(`${error.message}: ${JSON.stringify({ state: diagnostic, permissions, requests })}`)
      })
    }
    const activePage = () => BrowserWindow.getAllWindows()[0]?.contentView.children
      .find(view => view.webContents !== chrome && view.getVisible())?.webContents
    const startAnnotation = async () => {
      await chrome.executeJavaScript("document.getElementById('annotate').click()")
      return await waitFor(async () => {
        const page = activePage()
        if (page === undefined) return undefined
        return await page.executeJavaScript("Boolean(document.querySelector('#hydra-browser-annotation-overlay'))")
          ? page : undefined
      })
    }
    const dragRegion = async (page, pointerId) => {
      await page.executeJavaScript(`
        (() => {
          const overlay = document.querySelector('#hydra-browser-annotation-overlay')
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
    const configureNavigation = navigationPolicy => controller.command('configure_browser', {
      navigationPolicy, downloadDirectory: '', askWhereToSave: false, downloadPolicy: 'allow',
    })

    phase = 'waiting for the initial tab'
    await waitFor(async () => (await state()).count === 1)
    phase = 'syncing the app palette to native chrome'
    const systemTheme = (await state()).theme
    const appTheme = {
      colorScheme: 'dark',
      colors: {
        shell: '#101114',
        tabstrip: '#15171b',
        surface: '#25272b',
        text: '#f5f6f7',
        muted: '#a1a5ad',
        hover: '#30343a',
        border: '#464a52',
        accent: '#6ca7ff',
        accentText: '#101114',
        omnibox: '#17191d',
        status: '#20252d',
      },
    }
    assert.throws(() => controller.setTheme({ colorScheme: 'sepia', colors: appTheme.colors }), /colorScheme/)
    controller.setTheme(appTheme)
    await waitFor(async () => {
      const current = await state()
      return current.theme === 'dark' && JSON.stringify(controller.getState().themeColors) === JSON.stringify(appTheme.colors)
    })
    assert.deepEqual(await chromePalette(), { scheme: 'dark', ...appTheme.colors })
    controller.setTheme(null)
    await waitFor(async () => {
      const current = await state()
      return current.theme === systemTheme && controller.getState().themeColors === null
    })
    await navigate('/one')
    phase = 'waiting for first tab title'
    await waitFor(async () => (await state()).history.some(entry => entry.label === 'One' && entry.value === `${address}/one`))

    phase = 'agent action reveals the panel and HUD'
    await controller.command('navigate', { url: `${address}/two` })
    await waitFor(async () => {
      const current = await state()
      return current.url === `${address}/two` && current.activity.includes('Hydra: Navigate')
    })
    assert.ok(opened >= 1)
    assert.match((await state()).theme, /^(light|dark)$/)
    await navigate('/one')

    phase = 'showing the gradient only during browser commands'
    const maskState = () => activePage().executeJavaScript(`(() => {
      const mask = document.querySelector('#page-agent-runtime_simulator-mask')
      const cursor = mask?.querySelector('[class*="cursor_"]')
      const gradient = mask?.querySelector(':scope > :not([class*="cursor_"])')
      return {
        gradient: gradient && getComputedStyle(gradient).visibility,
        cursor: cursor && getComputedStyle(cursor).visibility,
        display: mask && getComputedStyle(mask).display,
        pointerEvents: mask && getComputedStyle(mask).pointerEvents,
      }
    })()`)
    await waitFor(async () => (await maskState()).gradient === 'hidden')
    assert.deepEqual(await maskState(), { gradient: 'hidden', cursor: 'visible', display: 'block', pointerEvents: 'none' })
    const waiting = controller.command('wait', { seconds: 1 })
    await waitFor(async () => (await maskState()).gradient === 'visible')
    await assert.rejects(controller.command('wait', { seconds: -1 }), /wait seconds/)
    assert.equal((await maskState()).gradient, 'visible')
    await waiting
    await waitFor(async () => (await maskState()).gradient === 'hidden')
    assert.equal((await maskState()).cursor, 'visible')
    await assert.rejects(controller.command('wait', { seconds: -1 }), /wait seconds/)
    await waitFor(async () => (await maskState()).gradient === 'hidden')

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
    phase = 'responsive browser chrome and page viewport'
    for (let count = 2; count <= 6; count += 1) {
      await chrome.executeJavaScript("document.getElementById('new-tab').click()")
      await waitFor(async () => (await state()).count === count)
    }
    await navigate('/one')
    const page = activePage()
    for (const width of [320, 480, 768, 1024]) {
      controller.setBounds({ x: 0, y: 0, width, height: 600, visible: true })
      await waitFor(async () => await chrome.executeJavaScript('innerWidth') === width)
      await waitFor(async () => await page.executeJavaScript('innerWidth') === width)
      const layout = await chrome.executeJavaScript(`(() => {
        const fits = element => {
          const rect = element.getBoundingClientRect()
          return rect.left >= 0 && rect.right <= innerWidth && rect.width > 0
        }
        const controls = [...document.querySelectorAll('.controls button, #omnibox, #new-tab')]
        const tabs = document.getElementById('tabs')
        const last = tabs.lastElementChild
        last.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        const bounds = tabs.getBoundingClientRect()
        const tab = last.getBoundingClientRect()
        return {
          controlsFit: controls.every(fits),
          addressUsable: document.getElementById('omnibox').getBoundingClientRect().width >= 100,
          lastTabReachable: tab.left >= bounds.left - 1 && tab.right <= bounds.right + 1,
          noDocumentOverflow: document.documentElement.scrollWidth === innerWidth,
        }
      })()`)
      assert.deepEqual(layout, {
        controlsFit: true,
        addressUsable: true,
        lastTabReachable: true,
        noDocumentOverflow: true,
      }, `browser layout at ${width}px`)
      assert.equal(await page.executeJavaScript('innerHeight'), 504)
    }
    phase = 'waiting for chat permission before a network request'
    await configureNavigation('ask')
    const target = `http://localhost:${server.address().port}/two`
    const reachedTarget = () => requests.filter(request => request.host === new URL(target).host && request.url === '/two').length
    const before = reachedTarget()
    const navigating = controller.command('navigate', { url: target })
    await waitFor(() => permissions.length === 1)
    assert.equal(reachedTarget(), before)
    assert.deepEqual(permissions[0].request, { kind: 'navigation', origin: new URL(target).origin })
    await controller.request({ method: 'browser_permission_response', args: { id: permissions[0].id, choice: 'once' } })
    await navigating
    assert.equal((await state()).url, target)
    assert.deepEqual(await controller.command('browser_sites'), [])

    phase = 'an action approval does not create a website rule'
    await configureNavigation('allow')
    await controller.command('navigate', { url: `${address}/one` })
    await configureNavigation('ask')
    const remembered = controller.command('navigate', { url: target })
    await waitFor(() => permissions.length === 2)
    await controller.request({ method: 'browser_permission_response', args: { id: permissions[1].id, choice: 'always' } })
    await remembered
    assert.deepEqual(await controller.command('browser_sites'), [])

    phase = 'cancelled chat permission does not navigate'
    const denied = controller.command('navigate', { url: `${address}/three` }).then(() => false, () => true)
    await waitFor(() => permissions.length === 3)
    controller.cancelPermissions()
    assert.equal(await denied, true)
    await controller.request({ method: 'browser_permission_response', args: { id: permissions[2].id, choice: 'always' } })
    assert.equal((await controller.command('browser_sites')).length, 0)
    phase = 'preserving a form POST while chat answers'
    await configureNavigation('allow')
    await controller.command('navigate', { url: `${address}/one` })
    await controller.command('remove_browser_site', { origin: new URL(target).origin })
    await configureNavigation('ask')
    await activePage().executeJavaScript(`(() => {
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = ${JSON.stringify(target)}
      const input = document.createElement('input')
      input.name = 'proof'
      input.value = 'kept through chat'
      form.append(input)
      document.body.append(form)
      form.submit()
    })()`)
    await waitFor(() => permissions.length === 4)
    assert.equal(requests.some(request => request.method === 'POST'), false)
    await controller.request({ method: 'browser_permission_response', args: { id: permissions[3].id, choice: 'once' } })
    await waitFor(() => requests.some(request => request.method === 'POST' && request.body === 'proof=kept+through+chat'))
    await waitFor(() => activePage().getURL() === target && !activePage().isLoading())
    phase = 'blocking a website from chat'
    await configureNavigation('allow')
    await controller.command('navigate', { url: `${address}/one` })
    await configureNavigation('ask')
    const blocked = controller.command('navigate', { url: target }).then(() => false, () => true)
    await waitFor(() => permissions.length === 5).catch(async error => {
      throw new Error(`${error.message}: ${JSON.stringify({ state: await state(), page: activePage().getURL(), permissions, requests })}`)
    })
    await controller.request({ method: 'browser_permission_response', args: { id: permissions[4].id, choice: 'block' } })
    assert.equal(await blocked, true)
    assert.deepEqual(await controller.command('browser_sites'), [])
    await configureNavigation('block')
    await assert.rejects(controller.command('navigate', { url: target }), /blocked/)
    assert.equal(permissions.length, 5)
    phase = 'closing the last controlled tab'
    await configureNavigation('allow')
    const tabIds = () => controller.getState().tabs.map(tab => tab.id)
    while (tabIds().length > 1) await controller.command('close_tab', { tabId: tabIds()[0] })
    const closeButtons = () => chrome.executeJavaScript('document.querySelectorAll(".tab-close").length')
    await waitFor(async () => tabIds().length === 1 && await closeButtons() === 1)
    const revealedBefore = opened
    await chrome.executeJavaScript("document.querySelector('.tab-close').click()")
    await waitFor(async () => closed === 1 && controller.getState().tabs.length === 0)
    // The empty browser must reach the chrome before a later reopen renders one
    // tab again, or a click could address the id the controller already dropped.
    await waitFor(async () => await closeButtons() === 0)
    assert.ok(
      !BrowserWindow.getAllWindows()[0].contentView.children.some(view => view.getVisible()),
      'a browser without tabs kept a native view visible',
    )

    phase = 'agent action reopens the closed browser'
    const reopened = await controller.command('get_browser_state', {})
    assert.equal(reopened.tabs.length, 1)
    assert.equal(reopened.url, 'about:blank')
    assert.ok(opened > revealedBefore, 'the agent did not reveal the closed browser again')

    phase = 'reopening the panel restores a controlled tab'
    // The chrome re-rendered from empty to the reopened tab.
    await waitFor(async () => await closeButtons() === 1)
    await chrome.executeJavaScript("document.querySelector('.tab-close').click()")
    await waitFor(async () => closed === 2 && controller.getState().tabs.length === 0)
    controller.setBounds({ x: 0, y: 0, width: 1024, height: 768, visible: false, present: false })
    controller.setBounds({ x: 0, y: 0, width: 1024, height: 768, visible: true, present: true })
    await waitFor(async () => controller.getState().tabs.length === 1)
    assert.equal((await controller.command('navigate', { url: `${address}/one` })).success, true)
    await waitFor(async () => (await state()).active === 'One')

    phase = 'opening a URL in a fresh tab after user closure'
    await chrome.executeJavaScript("document.querySelector('.tab-close').click()")
    await waitFor(async () => closed === 3 && controller.getState().tabs.length === 0)
    assert.equal((await controller.command('open_new_tab', { url: `${address}/two` })).success, true)
    await waitFor(async () => (await state()).active === 'Two')
    assert.equal(controller.getState().tabs.length, 1)

    phase = 'a page closing itself returns the panel to the renderer'
    activePage().close()
    await waitFor(async () => closed === 4 && controller.getState().tabs.length === 0)
    assert.equal((await controller.command('route_user_url', { url: `${address}/one` })).success, true)
    await waitFor(async () => (await state()).active === 'One')

    phase = 'closing the browser window'
    app.once('window-all-closed', () => finish(true))
    BrowserWindow.getAllWindows()[0]?.close()
  })().catch(error => finish(false, new Error(`${phase}: ${error.message}`)))
})
