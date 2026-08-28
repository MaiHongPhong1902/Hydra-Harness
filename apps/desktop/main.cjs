'use strict'

const { once } = require('node:events')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { readFile, readdir, realpath, stat } = require('node:fs/promises')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')
const { createInterface } = require('node:readline')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow, dialog, ipcMain, utilityProcess } = require('electron')
const nodePty = require('node-pty')

const CLI_ENTRY = join(require.resolve('@bosch/bh/package.json'), '..', 'lib', 'bin.js')
const BROWSER_ENTRY = join(require.resolve('@bosch/bh-browser-electron/package.json'), '..', 'electron-app', 'main.cjs')
const SMOKE = process.argv.includes('--smoke')
const HOST_READY_TIMEOUT_MS = 90_000
const HOST_SHUTDOWN_TIMEOUT_MS = 7_000
const HOST_URL = /^bh web: (http:\/\/127\.0\.0\.1:\d+)$/u
const DESKTOP_WORKSPACE_ROOT = resolve(process.env.BH_DESKTOP_WORKSPACE_ROOT ?? join(__dirname, '..', '..'))

app.setName('WorkON')
app.setPath('userData', join(process.env.BH_HOME || join(app.getPath('home'), '.bh'), 'desktop-electron'))

let mainWindow
let host
let browser
let browserConnection
let browserBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }
const terminals = new Map()

function panelShortcut(input) {
  if (!input.control || input.meta) return undefined
  if (input.shift) return !input.alt && input.key.toLowerCase() === 'b' ? 'browser' : undefined
  if (input.alt) return input.key.toLowerCase() === 's' ? 'side-chat' : undefined
  if (input.key.toLowerCase() === 'p') return 'files'
  if (input.key.toLowerCase() === 't') return 'browser'
  if (input.key === '`' || input.code === 'Backquote') return 'terminal'
  return undefined
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (event, input) => {
    const shortcut = panelShortcut(input)
    if (shortcut === undefined || mainWindow === undefined || mainWindow.isDestroyed()) return
    event.preventDefault()
    mainWindow.webContents.send('bh-desktop:panel-shortcut', shortcut)
  })
})
let shuttingDown
let hostExited = false
let hostExitCode

function postBrowser(connectionId, type, payload = {}) {
  if (host === undefined || hostExited) return
  host.postMessage({ type, connectionId, ...payload })
}

function parseBrowserLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

async function handleBrowserMessage(message) {
  if (typeof message !== 'object' || message === null || !('type' in message)) return
  if (message.type === 'bh-browser-connect') {
    if (typeof message.connectionId !== 'string') return
    if (browserConnection !== undefined && browserConnection !== message.connectionId) {
      postBrowser(message.connectionId, 'bh-browser-error', { error: 'another agent already owns the desktop browser' })
      postBrowser(message.connectionId, 'bh-browser-close')
      return
    }
    browserConnection = message.connectionId
    const settings = typeof message.settings === 'object' && message.settings !== null ? message.settings : {}
    try {
      await browser.command('configure_browser', settings)
    } catch (error) {
      postBrowser(message.connectionId, 'bh-browser-error', { error: String(error) })
      postBrowser(message.connectionId, 'bh-browser-close')
      browserConnection = undefined
      return
    }
    const homeUrl = typeof message.settings === 'object' && message.settings !== null
      && 'homeUrl' in message.settings && typeof message.settings.homeUrl === 'string'
      ? message.settings.homeUrl
      : undefined
    if (homeUrl !== undefined) {
      try { await browser.command('navigate', { url: homeUrl }) } catch {}
    }
    postBrowser(message.connectionId, 'bh-browser-line', { line: JSON.stringify({ event: 'ready' }) })
    return
  }
  if (message.type === 'bh-browser-disconnect') {
    if (message.connectionId === browserConnection) browserConnection = undefined
    return
  }
  if (message.type !== 'bh-browser-line' || message.connectionId !== browserConnection || typeof message.line !== 'string') return
  const request = parseBrowserLine(message.line)
  if (request === undefined) return
  const reply = await browser.request(request)
  if (reply !== undefined) {
    postBrowser(message.connectionId, 'bh-browser-line', { line: JSON.stringify(reply) })
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#111315',
    title: 'WorkON',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void routeAppUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (current === '' || current === 'about:blank') return
    try {
      if (new URL(current).origin === new URL(url).origin) return
    } catch {}
    event.preventDefault()
    void routeAppUrl(url)
  })
  window.on('page-title-updated', event => { event.preventDefault() })
  return window
}

async function routeAppUrl(url) {
  if (shuttingDown !== undefined || browser === undefined) return
  try {
    await browser.command('route_user_url', { url })
  } catch (error) {
    process.stderr.write(`desktop: URL routing failed: ${String(error)}\n`)
  }
}

function installBrowserController(window) {
  const registered = Promise.withResolvers()
  globalThis.__BH_BROWSER_EMBED__ = {
    window,
    config: {
      persistSessionCookies: true,
      readinessTimeoutMs: 45_000,
      experimentalScriptExecution: true,
    },
    send(message) {
      if (browserConnection !== undefined) {
        postBrowser(browserConnection, 'bh-browser-line', { line: JSON.stringify(message) })
      }
    },
    onState(state) {
      void state
    },
    onAnnotation(annotation) {
      if (!window.isDestroyed()) window.webContents.send('bh-desktop:browser-annotation', annotation)
    },
    openBrowser() {
      if (!window.isDestroyed()) window.webContents.send('bh-desktop:panel-shortcut', 'browser')
    },
    register(controller) { registered.resolve(controller) },
  }
  require(BROWSER_ENTRY)
  return registered.promise
}

function startHost() {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error('Desktop Host is not built. Run `pnpm run build` first.')
  }
  const child = utilityProcess.fork(CLI_ENTRY, [
    'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, BH_DESKTOP_BROWSER_BRIDGE: 'parent-port' },
    // Electron's Node ABI cannot use the system-Node native helper that exposes
    // the Loader internals. The built-in flag gives profile-relative plugin
    // resolution the same hook without loading that addon.
    execArgv: ['--expose-internals'],
    serviceName: 'WorkON Host',
    stdio: 'pipe',
  })
  host = child
  child.on('message', message => { void handleBrowserMessage(message) })
  child.on('exit', (code) => {
    hostExited = true
    hostExitCode = code
  })
  child.stderr?.on('data', chunk => { process.stderr.write(chunk) })

  const ready = Promise.withResolvers()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    process.stdout.write(`${line}\n`)
    const match = HOST_URL.exec(line.trim())
    if (match?.[1] !== undefined) ready.resolve(match[1])
  })
  child.once('exit', (code) => {
    ready.reject(new Error(`WorkON Host exited before readiness (code ${String(code)})`))
  })
  const timeout = setTimeout(() => {
    ready.reject(new Error(`WorkON Host did not become ready within ${HOST_READY_TIMEOUT_MS}ms`))
  }, HOST_READY_TIMEOUT_MS)
  return ready.promise.finally(() => { clearTimeout(timeout) })
}

function validSender(event) {
  return mainWindow !== undefined && event.sender === mainWindow.webContents
}

function terminalSize(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const cols = Number(value.cols)
  const rows = Number(value.rows)
  if (!Number.isInteger(cols) || cols < 2 || cols > 500) return undefined
  if (!Number.isInteger(rows) || rows < 1 || rows > 200) return undefined
  return { cols, rows }
}

function sendTerminalEvent(terminalId, value) {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('bh-desktop:terminal-event', { terminalId, event: value })
}

function terminalId(value) {
  return value === 'bottom' || value === 'right' ? value : undefined
}

function releaseTerminal(id, instance) {
  const record = terminals.get(id)
  if (record?.instance !== instance) return
  terminals.delete(id)
  for (const subscription of record.subscriptions) subscription.dispose()
}

async function startTerminal(id, size) {
  const current = terminals.get(id)
  if (current !== undefined) {
    try { current.instance.resize(size.cols, size.rows) } catch {}
    return { running: true }
  }
  const { scrubbedParentEnv } = await import('@bosch/bh-subprocess')
  const env = scrubbedParentEnv()
  const shell = process.platform === 'win32'
    ? Object.entries(env).find(([key]) => key.toUpperCase() === 'COMSPEC')?.[1] ?? 'cmd.exe'
    : env.SHELL ?? '/bin/sh'
  const args = process.platform === 'win32' ? ['/Q', '/D', '/K'] : ['-i']
  const instance = nodePty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.cwd(),
    env,
  })
  const record = { instance, subscriptions: [], output: '' }
  terminals.set(id, record)
  const data = instance.onData((value) => {
    record.output = (record.output + value).slice(-200_000)
    sendTerminalEvent(id, { type: 'data', data: value })
  })
  const exited = instance.onExit(({ exitCode }) => {
    releaseTerminal(id, instance)
    sendTerminalEvent(id, { type: 'exit', code: exitCode })
  })
  record.subscriptions = [data, exited]
  return { running: true }
}

async function stopTerminal(id) {
  const record = terminals.get(id)
  if (record === undefined) return
  const { instance } = record
  const exited = Promise.withResolvers()
  const wait = instance.onExit(() => { exited.resolve() })
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(instance.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', resolve)
      killer.once('exit', resolve)
    })
  } else {
    try { instance.kill() } catch {}
  }
  await Promise.race([exited.promise, delay(2_000)])
  wait.dispose()
  if (terminals.get(id)?.instance === instance) {
    try { instance.kill() } catch {}
    releaseTerminal(id, instance)
  }
}

async function confinedPath(target = DESKTOP_WORKSPACE_ROOT) {
  if (typeof target !== 'string') {
    throw new Error('workspace path is invalid')
  }
  const base = await realpath(DESKTOP_WORKSPACE_ROOT)
  const candidate = await realpath(resolve(target))
  const inside = relative(base, candidate)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('path is outside the workspace')
  }
  return candidate
}

async function listFiles(target) {
  const path = await confinedPath(target)
  const entries = await readdir(path, { withFileTypes: true })
  return entries
    .filter(entry => !entry.isSymbolicLink())
    .map(entry => ({ name: entry.name, path: join(path, entry.name), directory: entry.isDirectory() }))
    .sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name))
}

async function readWorkspaceFile(target) {
  const path = await confinedPath(target)
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error('path is not a file')
  if (metadata.size > 1_000_000) throw new Error('file is larger than 1 MB')
  const bytes = await readFile(path)
  if (bytes.includes(0)) throw new Error('binary files are not previewed')
  return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
}

function installRendererIpc() {
  const browserOperation = async (event, method, args = {}) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('browser management is unavailable')
    return await browser.command(method, args)
  }
  ipcMain.on('bh-desktop:browser-bounds', (event, value) => {
    if (shuttingDown !== undefined || !validSender(event) || typeof value !== 'object' || value === null) return
    const [windowWidth, windowHeight] = mainWindow.getContentSize()
    const zoom = mainWindow.webContents.getZoomFactor()
    const dip = input => Math.round((Number(input) || 0) * zoom)
    const x = Math.min(windowWidth, Math.max(0, dip(value.x)))
    const y = Math.min(windowHeight, Math.max(0, dip(value.y)))
    browserBounds = {
      x,
      y,
      width: Math.min(windowWidth - x, Math.max(0, dip(value.width))),
      height: Math.min(windowHeight - y, Math.max(0, dip(value.height))),
      visible: value.visible === true,
    }
    browser.setBounds(browserBounds)
  })
  ipcMain.handle('bh-desktop:browser-configure', (event, value) =>
    browserOperation(event, 'configure_browser', value))
  ipcMain.handle('bh-desktop:browser-confirm-full-cdp', async (event) => {
    if (shuttingDown !== undefined || !validSender(event)) return false
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Enable full CDP access?',
      message: 'Full Chrome DevTools Protocol access has elevated risk.',
      detail: 'It can inspect and control sensitive browser internals. Every CDP command will still require separate approval.',
      buttons: ['Enable', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return choice.response === 0
  })
  ipcMain.handle('bh-desktop:browser-clear-data', event =>
    browserOperation(event, 'clear_browser_data'))
  ipcMain.handle('bh-desktop:browser-open-url', (event, value) =>
    browserOperation(event, 'route_user_url', value))
  ipcMain.handle('bh-desktop:browser-history', event =>
    browserOperation(event, 'browser_history'))
  ipcMain.handle('bh-desktop:browser-remove-history', (event, value) =>
    browserOperation(event, 'remove_browser_history', value))
  ipcMain.handle('bh-desktop:browser-downloads', event =>
    browserOperation(event, 'browser_downloads'))
  ipcMain.handle('bh-desktop:browser-remove-download', (event, value) =>
    browserOperation(event, 'remove_browser_download', value))
  ipcMain.handle('bh-desktop:browser-sites', event =>
    browserOperation(event, 'browser_sites'))
  ipcMain.handle('bh-desktop:browser-set-site', (event, value) =>
    browserOperation(event, 'set_browser_site', value))
  ipcMain.handle('bh-desktop:browser-remove-site', (event, value) =>
    browserOperation(event, 'remove_browser_site', value))
  ipcMain.handle('bh-desktop:browser-autofill-status', event =>
    browserOperation(event, 'autofill_status'))
  ipcMain.handle('bh-desktop:browser-autofill-list-logins', event =>
    browserOperation(event, 'autofill_list_logins'))
  ipcMain.handle('bh-desktop:browser-autofill-save-login', (event, value) =>
    browserOperation(event, 'autofill_save_login', value))
  ipcMain.handle('bh-desktop:browser-autofill-remove-login', (event, value) =>
    browserOperation(event, 'autofill_remove_login', value))
  ipcMain.handle('bh-desktop:browser-autofill-list-contacts', event =>
    browserOperation(event, 'autofill_list_contacts'))
  ipcMain.handle('bh-desktop:browser-autofill-get-contact', (event, value) =>
    browserOperation(event, 'autofill_get_contact', value))
  ipcMain.handle('bh-desktop:browser-autofill-save-contact', (event, value) =>
    browserOperation(event, 'autofill_save_contact', value))
  ipcMain.handle('bh-desktop:browser-autofill-remove-contact', (event, value) =>
    browserOperation(event, 'autofill_remove_contact', value))
  ipcMain.handle('bh-desktop:terminal-start', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('terminal is unavailable')
    const id = terminalId(value?.terminalId)
    const size = terminalSize(value?.size)
    if (id === undefined || size === undefined) throw new Error('terminal request is invalid')
    return await startTerminal(id, size)
  })
  ipcMain.handle('bh-desktop:terminal-stop', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('terminal is unavailable')
    const id = terminalId(value?.terminalId)
    if (id === undefined) throw new Error('terminal request is invalid')
    await stopTerminal(id)
  })
  ipcMain.on('bh-desktop:terminal-write', (event, value) => {
    const id = terminalId(value?.terminalId)
    if (shuttingDown !== undefined || !validSender(event) || id === undefined
      || typeof value?.data !== 'string' || value.data.length > 65_536) return
    try { terminals.get(id)?.instance.write(value.data) } catch {}
  })
  ipcMain.on('bh-desktop:terminal-resize', (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) return
    const id = terminalId(value?.terminalId)
    const size = terminalSize(value?.size)
    if (id === undefined || size === undefined) return
    try { terminals.get(id)?.instance.resize(size.cols, size.rows) } catch {}
  })
  ipcMain.handle('bh-desktop:files-root', async (event) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await realpath(DESKTOP_WORKSPACE_ROOT)
  })
  ipcMain.handle('bh-desktop:files-list', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await listFiles(value?.path)
  })
  ipcMain.handle('bh-desktop:files-read', async (event, value) => {
    if (shuttingDown !== undefined || !validSender(event)) throw new Error('files are unavailable')
    return await readWorkspaceFile(value?.path)
  })
}

function assertNativeViews(panel) {
  const visible = mainWindow.contentView.children
    .filter(view => view.getVisible())
    .map(view => view.getBounds())
    .sort((left, right) => left.y - right.y)
  const [chrome, page] = visible
  const valid = visible.length === 2
    && chrome.x === panel.x && chrome.y === panel.y && chrome.width === panel.width
    && page.x === panel.x && page.y === chrome.y + chrome.height && page.width === panel.width
    && page.y + page.height === panel.y + panel.height
  if (!valid) {
    throw new Error(`native browser views do not fill the panel: ${JSON.stringify({ panel, visible })}`)
  }
}

async function waitForBounds(label, predicate) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (browserBounds.visible && browserBounds.width > 100 && browserBounds.height > 100 && predicate(browserBounds)) {
      return { ...browserBounds }
    }
    await delay(100)
  }
  throw new Error(`${label} browser view has unusable bounds: ${JSON.stringify(browserBounds)}`)
}

async function waitForHiddenBrowser(label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const visibleViews = mainWindow.contentView.children.filter(view => view.getVisible())
    if (!browserBounds.visible && visibleViews.length === 0) return
    await delay(100)
  }
  throw new Error(`${label} did not hide native browser views: ${JSON.stringify(browserBounds)}`)
}

async function selectControl(label) {
  const clicked = await mainWindow.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[aria-label=${JSON.stringify(label)}]')
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error(`desktop panel control is missing: ${label}`)
}

async function waitForTerminal(id, label, predicate) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const terminal = terminals.get(id)
    if (terminal !== undefined && predicate(terminal)) return
    await delay(100)
  }
  throw new Error(`${label} terminal check failed`)
}

async function waitForRenderer(label, expression) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await mainWindow.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await delay(100)
  }
  throw new Error(`${label} renderer check failed`)
}

async function smoke() {
  const panelStartsClosed = await mainWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('[aria-label="Right panel"]')
    return panel instanceof HTMLElement && panel.hidden
  })()`)
  if (!panelStartsClosed) throw new Error('desktop browser panel opens by default')
  if (mainWindow.getTitle() !== 'WorkON') throw new Error(`unexpected desktop title: ${mainWindow.getTitle()}`)
  if (panelShortcut({ control: true, alt: false, meta: false, shift: false, key: 'p' }) !== 'files'
    || panelShortcut({ control: true, alt: true, meta: false, shift: false, key: 's' }) !== 'side-chat'
    || panelShortcut({ control: true, alt: false, meta: false, shift: true, key: 'b' }) !== 'browser'
    || panelShortcut({ control: true, alt: false, meta: false, shift: false, key: 't' }) !== 'browser'
    || panelShortcut({ control: true, alt: false, meta: false, shift: false, key: '`' }) !== 'terminal') {
    throw new Error('desktop panel shortcut mapping is invalid')
  }
  const rootFiles = await listFiles(DESKTOP_WORKSPACE_ROOT)
  if (rootFiles.length === 0) throw new Error('desktop workspace tree is empty')
  try {
    await readWorkspaceFile(resolve(DESKTOP_WORKSPACE_ROOT, '..'))
    throw new Error('desktop Files bridge escaped its workspace root')
  } catch (error) {
    if (!String(error).includes('outside the workspace')) throw error
  }
  await selectControl('Toggle right panel')
  const right = await waitForBounds('right', bounds => bounds.x > 0 && bounds.width < mainWindow.getContentBounds().width)
  assertNativeViews(right)
  await selectControl('Choose panel')
  await waitForHiddenBrowser('panel chooser')
  const chooser = await mainWindow.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose panel"]')
    if (!(dialog instanceof HTMLElement)) return undefined
    return [...dialog.querySelectorAll('button')].map(button => ({
      text: button.textContent?.trim(),
      disabled: button.disabled,
      shortcut: button.getAttribute('aria-keyshortcuts'),
    }))
  })()`)
  if (JSON.stringify(chooser) !== JSON.stringify([
    { text: 'FilesCtrl+P', disabled: false, shortcut: 'Control+P' },
    { text: 'Side chatCtrl+Alt+S', disabled: false, shortcut: 'Control+Alt+S' },
    { text: 'BrowserCtrl+Shift+B', disabled: false, shortcut: 'Control+Shift+B' },
    { text: 'TerminalCtrl+`', disabled: false, shortcut: 'Control+Backquote' },
  ])) {
    throw new Error(`panel chooser contract is invalid: ${JSON.stringify(chooser)}`)
  }
  await selectControl('Files')
  await waitForHiddenBrowser('Files panel')
  await waitForRenderer('workspace Files panel', `document.querySelector('[data-panel-kind="files"]:not([hidden]) [aria-label="Workspace files"] [role="treeitem"]')`)
  await selectControl('Choose panel')
  await selectControl('Terminal')
  await waitForHiddenBrowser('right Terminal')
  await waitForRenderer('right Terminal panel', `document.querySelector('[aria-label="Right terminal"]:not([hidden])')`)
  await waitForTerminal('right', 'right startup', () => true)
  await selectControl('Toggle bottom terminal')
  const terminalsVisible = await mainWindow.webContents.executeJavaScript(`(() => {
    const bottom = document.querySelector('[aria-label="Terminal"]')
    const right = document.querySelector('[aria-label="Right terminal"]')
    return bottom instanceof HTMLElement && !bottom.hidden && right instanceof HTMLElement && !right.hidden
  })()`)
  if (!terminalsVisible) throw new Error('right and bottom Terminal panels did not open together')
  await waitForTerminal('bottom', 'bottom startup', () => true)
  const marker = `BH_TERMINAL_SMOKE_${Date.now()}`
  const rightMarker = `${marker}_RIGHT`
  const bottomMarker = `${marker}_BOTTOM`
  await mainWindow.webContents.executeJavaScript(`(() => {
    window.bhDesktop?.terminal?.write('right', ${JSON.stringify(`echo ${rightMarker}\r`)})
    window.bhDesktop?.terminal?.write('bottom', ${JSON.stringify(`echo ${bottomMarker}\r`)})
  })()`)
  await waitForTerminal('right', 'right command output', terminal => terminal.output.includes(rightMarker))
  await waitForTerminal('bottom', 'bottom command output', terminal => terminal.output.includes(bottomMarker))
  if (terminals.get('right').output.includes(bottomMarker) || terminals.get('bottom').output.includes(rightMarker)) {
    throw new Error('right and bottom Terminal output crossed PTY boundaries')
  }
  const panels = await mainWindow.webContents.executeJavaScript(`(() => {
    const right = document.querySelector('[aria-label="Right panel"]')?.getBoundingClientRect()
    const bottom = document.querySelector('[aria-label="Terminal"]')?.getBoundingClientRect()
    return right && bottom ? {
      right: { left: right.left, top: right.top, bottom: right.bottom },
      bottom: { left: bottom.left, top: bottom.top, right: bottom.right },
    } : undefined
  })()`)
  if (panels === undefined || panels.bottom.top <= panels.right.top || panels.bottom.right > panels.right.left + 1) {
    throw new Error(`right and bottom panels overlap: ${JSON.stringify(panels)}`)
  }
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] })
  const simultaneous = await waitForBounds('right with bottom Terminal', bounds => bounds.x > 0 && bounds.width < mainWindow.getContentBounds().width)
  assertNativeViews(simultaneous)
  await mainWindow.webContents.executeJavaScript(`(() => {
    const dialog = document.createElement('div')
    dialog.id = 'desktop-smoke-modal'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
  })()`)
  await waitForHiddenBrowser('renderer modal')
  await mainWindow.webContents.executeJavaScript("document.querySelector('#desktop-smoke-modal')?.remove()")
  assertNativeViews(await waitForBounds('right after modal', bounds => bounds.x > 0 && bounds.width < mainWindow.getContentBounds().width))
  await selectControl('Expand right panel')
  const expanded = await waitForBounds(
    'expanded',
    bounds => bounds.width > simultaneous.width,
  )
  assertNativeViews(expanded)
  await selectControl('Expand right panel')
  const restored = await waitForBounds('restored right', bounds => bounds.width < expanded.width)
  assertNativeViews(restored)
  const terminalRestored = await mainWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('[aria-label="Terminal"]')
    const button = document.querySelector('[aria-label="Toggle bottom terminal"]')
    return panel instanceof HTMLElement && !panel.hidden && button?.getAttribute('aria-pressed') === 'true'
  })()`)
  if (!terminalRestored) throw new Error('Terminal did not restore after Browser expand')
  await selectControl('Toggle right panel')
  await waitForHiddenBrowser('right panel close')
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] })
  assertNativeViews(await waitForBounds('right panel reopen', bounds => bounds.width < expanded.width))
  if (BrowserWindow.getAllWindows().length !== 1) {
    throw new Error(`desktop opened ${BrowserWindow.getAllWindows().length} BrowserWindows instead of one`)
  }
  const beforeClose = browser.getState()
  if (beforeClose?.tabs.length !== 1 || beforeClose.activeTabId !== beforeClose.tabs[0]?.id) {
    throw new Error(`desktop browser tab state is invalid: ${JSON.stringify(beforeClose)}`)
  }
  await browser.command('close_tab', { tabId: beforeClose.activeTabId })
  const afterClose = browser.getState()
  if (BrowserWindow.getAllWindows().length !== 1 || afterClose?.tabs.length !== 1) {
    throw new Error(`closing the last browser tab closed the desktop: ${JSON.stringify(afterClose)}`)
  }
  process.stdout.write(`${JSON.stringify({
    event: 'desktop-smoke',
    ok: true,
    windows: 1,
    terminal: { rightMarker, bottomMarker, simultaneous: true, isolated: true },
    bounds: { right, simultaneous, expanded, restored },
  })}\n`)
}

async function shutdown() {
  if (shuttingDown !== undefined) return await shuttingDown
  shuttingDown = (async () => {
    try { await Promise.all([...terminals.keys()].map(stopTerminal)) } catch (error) { process.stderr.write(`${String(error)}\n`) }
    try { await browser?.dispose() } catch (error) { process.stderr.write(`${String(error)}\n`) }
    if (host !== undefined && !hostExited) {
      const exited = once(host, 'exit')
      host.postMessage({ type: 'shutdown' })
      const stopped = await Promise.race([exited.then(() => true), delay(HOST_SHUTDOWN_TIMEOUT_MS).then(() => false)])
      if (!stopped) host.kill()
      if (SMOKE && (!stopped || hostExitCode !== 0)) {
        process.stderr.write(`desktop: Host shutdown was not clean (code ${String(hostExitCode)})\n`)
        process.exitCode = 1
      }
    }
    mainWindow?.destroy()
    app.exit(process.exitCode ?? 0)
  })()
  return await shuttingDown
}

app.whenReady().then(async () => {
  try {
    mainWindow = createWindow()
    browser = await installBrowserController(mainWindow)
    installRendererIpc()
    const url = await startHost()
    await mainWindow.loadURL(url)
    if (!SMOKE) mainWindow.show()
    mainWindow.on('close', event => {
      if (shuttingDown === undefined) {
        event.preventDefault()
        void shutdown()
      }
    })
    if (SMOKE) {
      await smoke()
      await shutdown()
    }
  } catch (error) {
    process.stderr.write(`desktop: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
    await shutdown()
  }
})

app.on('window-all-closed', () => { if (shuttingDown === undefined) void shutdown() })
