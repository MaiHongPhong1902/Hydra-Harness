// Electron main process for the harness's embedded browser. Spawned by
// `@bosch/bh-browser-electron`; it owns one window holding controlled tab views
// and speaks NDJSON over stdio.
//
// Protocol, one JSON object per line:
//   in   {"id":1,"method":"navigate","args":{"url":"https://…"}}
//   out  {"id":1,"ok":true,"result":{…}}  |  {"id":1,"ok":false,"error":"…"}
//
// stdout IS the channel. Nothing here may `console.log`; every diagnostic goes
// to stderr, which the parent surfaces as launch-failure detail.
'use strict'

const { once } = require('node:events')
const { createReadStream } = require('node:fs')
const { createInterface } = require('node:readline')
const { basename, join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const { app, BrowserWindow, Menu, WebContentsView, ipcMain, session } = require('electron')

/**
 * The desktop shell may host this controller in-process. Standalone launches
 * keep the original argv/stdout protocol used by BrowserSessionService.
 */
const embedded = globalThis.__BH_BROWSER_EMBED__
/** Config from the parent, or defaults when run by hand for a smoke test. */
const config = embedded?.config ?? JSON.parse(process.argv[2] ?? '{}')
const CHROME_HEIGHT = 74
const READINESS_TIMEOUT_MS = config.readinessTimeoutMs ?? 45_000
const READINESS_POLL_MS = 250
const READINESS_SETTLE_MS = 500

/** Optional profile-owned home page; config validation happens in the parent. */
const HOME_URL = typeof config.homeUrl === 'string' && config.homeUrl.length > 0 ? config.homeUrl : undefined
const PERSIST_SESSION_COOKIES = config.persistSessionCookies === true
const SESSION_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60

/** Pending native cookie-store writes, flushed before a harness-owned exit. */
const sessionCookieWrites = new Set()
/** Controlled pages share one Chromium session, isolated from the app renderer. */
let browserSession

const log = (...parts) => console.error('[bh-browser]', ...parts)

const send = (message) => {
  if (embedded !== undefined) embedded.send(message)
  else process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Keep an SSO session cookie in Chromium's encrypted on-disk store. */
function persistSessionCookie(cookie) {
  if (!PERSIST_SESSION_COOKIES || cookie.expirationDate !== undefined) return
  const host = cookie.domain.replace(/^\./, '')
  const task = browserSession.cookies.set({
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...cookie.hostOnly ? {} : { domain: cookie.domain },
    expirationDate: Math.floor(Date.now() / 1_000) + SESSION_COOKIE_TTL_SECONDS,
  }).then(() => browserSession.cookies.flushStore()).catch(error => {
    log('session-cookie persistence failed:', error)
  })
  sessionCookieWrites.add(task)
  void task.finally(() => sessionCookieWrites.delete(task))
}

async function flushSessionCookies() {
  if (!PERSIST_SESSION_COOKIES) return
  await Promise.all([...sessionCookieWrites])
  await browserSession.cookies.flushStore()
}

/** In-flight `page-control` requests, keyed by the id the preload echoes back. */
const pendingPageCalls = new Map()
let nextPageCallId = 1

/** In-flight PageAgent model requests awaiting the owning BH agent. */
const pendingPageAgentLlmCalls = new Map()
let nextPageAgentLlmCallId = 1

/** @typedef {{ id: number, view: import('electron').WebContentsView }} Tab */

/** @type {Map<number, Tab>} */
const tabs = new Map()
let nextTabId = 1
/** @type {Tab | undefined} */
let activeTab
/** @type {import('electron').BrowserWindow} */
let window
/** @type {import('electron').WebContentsView | undefined} */
let chrome
/** Last renderer-owned rectangle for an in-process controlled browser. */
let embeddedBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }
/** Last browser chrome state, also returned to a newly mounted desktop panel. */
let chromeState
let windowClosing = false
/** @type {(() => Tab) | undefined} */
let createTab
/** @type {((tab: Tab) => void) | undefined} */
let selectTab
/** @type {((tab: Tab) => void) | undefined} */
let closeTab

/** Resolve an omnibox entry as an address when possible, otherwise a search. */
function resolveOmnibox(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch {}
  if (/^(?:localhost|[^\s/.]+(?:\.[^\s/.]+)+)(?::\d+)?(?:[/?#].*)?$/u.test(value)) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

/** Keep the native browser chrome in sync with every tab and the selected page. */
function updateChrome() {
  if (windowClosing || !activeTab) return
  const contents = activeTab.view.webContents
  if (contents.isDestroyed()) return
  chromeState = {
    tabs: Array.from(tabs.values(), tab => ({ id: tab.id, title: tab.view.webContents.getTitle() || 'New Tab' })),
    activeTabId: activeTab.id,
    url: contents.getURL(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  }
  if (embedded !== undefined) embedded.onState(chromeState)
  if (chrome !== undefined && !chrome.webContents.isDestroyed()) {
    chrome.webContents.send('browser-chrome:update', chromeState)
  }
}

/**
 * Fail every in-flight page call for one tab. That tab's preload can no longer
 * settle them, while calls in other tabs remain valid.
 * @param {Tab} tab - tab whose calls must reject.
 * @param {string} reason - what happened, surfaced to the caller.
 */
function abortPageCalls(tab, reason) {
  for (const [id, pending] of pendingPageCalls) {
    if (pending.tab !== tab) continue
    pending.reject(new Error(reason))
    pendingPageCalls.delete(id)
  }
}

/** Reject model requests whose isolated-world document no longer exists. */
function abortPageAgentLlmCalls(tab, reason) {
  for (const [id, pending] of pendingPageAgentLlmCalls) {
    if (pending.tab !== tab) continue
    pending.reject(new Error(reason))
    pendingPageAgentLlmCalls.delete(id)
  }
}

/** Ask the owning BH process to run one PageAgent model step. */
function pageAgentLlm(tab, request) {
  return new Promise((resolve, reject) => {
    const id = nextPageAgentLlmCallId++
    pendingPageAgentLlmCalls.set(id, { resolve, reject, tab })
    send({ event: 'page-agent:llm', id, tabId: tab.id, request })
  })
}

/**
 * Forward one action to the preload and await its reply.
 * @param {Tab} tab - tab whose preload owns the request.
 * @param {string} action - action name the preload's dispatch understands.
 * @param {Record<string, unknown>} args - JSON-safe action arguments.
 * @returns {Promise<unknown>} the preload's JSON-safe result.
 */
function pageControl(tab, action, args) {
  return new Promise((resolve, reject) => {
    const id = nextPageCallId++
    pendingPageCalls.set(id, { resolve, reject, tab })
    tab.view.webContents.send('page-control', { id, action, args })
  })
}

/** Cancel a manual picker without exposing the private preload channel. */
function cancelAnnotation(tab) {
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.send('page-annotation:cancel')
}

/** Validate and bound page-owned annotation data before it reaches the app renderer. */
function annotationOf(value) {
  if (typeof value !== 'object' || value === null || value.kind !== 'browser-element'
    || typeof value.url !== 'string' || typeof value.title !== 'string' || typeof value.preview !== 'string') return undefined
  if (value.url.length > 2_048 || value.title.length > 160 || value.preview.length > 1_024) return undefined
  if (value.index !== undefined && (!Number.isInteger(value.index) || value.index < 0)) return undefined
  return {
    kind: 'browser-element',
    url: value.url,
    title: value.title,
    preview: value.preview,
    ...(value.index === undefined ? {} : { index: value.index }),
  }
}

/** Insert one selected element into the desktop's main composer. */
async function publishAnnotation(tab, action, args) {
  try {
    const annotation = annotationOf(await pageControl(tab, action, args))
    if (annotation !== undefined && activeTab === tab) embedded?.onAnnotation?.(annotation)
  } catch (error) {
    if (!isNavigationInterruption(error)) log('annotation failed:', error)
  }
}

/** Native page menu matching the desktop browser controls. */
function openPageMenu(tab, params) {
  if (activeTab !== tab || windowClosing) return
  const contents = tab.view.webContents
  const history = contents.navigationHistory
  const annotationEnabled = typeof embedded?.onAnnotation === 'function'
  Menu.buildFromTemplate([
    {
      label: 'Quick annotate',
      enabled: annotationEnabled,
      click: () => { void publishAnnotation(tab, 'annotate_element_at', { x: params.x, y: params.y }) },
    },
    {
      label: 'Annotate',
      enabled: annotationEnabled,
      click: () => { void publishAnnotation(tab, 'annotate_element', {}) },
    },
    { type: 'separator' },
    { label: 'Back', enabled: history.canGoBack(), click: () => { history.goBack() } },
    { label: 'Forward', enabled: history.canGoForward(), click: () => { history.goForward() } },
    { label: 'Reload', click: () => { contents.reload() } },
    { type: 'separator' },
    { label: 'Inspect', click: () => { contents.inspectElement(params.x, params.y) } },
  ]).popup({ window })
}

/** Whether a page-control request was invalidated by a document/tab transition. */
function isNavigationInterruption(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('page navigated away')
}

/** Whether PageController ran while Chromium had replaced the document body. */
function isTransientPageStateError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /^Cannot read properties of null \(reading '(?:scrollWidth|scrollHeight)'\)$/.test(message)
}

/** Current tab inventory, shared by structured output and the prompt header. */
function tabStates() {
  return Array.from(tabs.values(), tab => {
    const contents = tab.view.webContents
    return {
      id: tab.id,
      url: contents.getURL() || 'about:blank',
      title: contents.getTitle() || 'New Tab',
      status: contents.isLoadingMainFrame() ? 'loading' : 'complete',
      active: activeTab === tab,
    }
  })
}

/** Add browser-window evidence that PageController cannot observe by itself. */
function completeState(tab, state, settled) {
  const inventory = tabStates()
  return {
    ...state,
    tabs: inventory,
    tabId: tab.id,
    activeTabId: activeTab?.id ?? tab.id,
    settled,
    capturedAt: new Date().toISOString(),
  }
}

/** A non-blank PageController observation, or the intentionally blank new tab. */
function isUsableState(state) {
  if (state.url === 'about:blank') return true
  return state.title.trim().length > 0
    || (state.content.trim().length > 0 && state.content.trim() !== '<EMPTY>')
}

/**
 * Read one document, optionally following selected-tab changes and SPA/SSO
 * transitions until Chromium is idle and PageController exposes usable content.
 */
async function readBrowserState(tab, waitForReady, followActive) {
  const deadline = Date.now() + (waitForReady ? READINESS_TIMEOUT_MS : 0)
  let candidateSince
  let candidateUrl
  let lastState
  let lastTab = tab
  let lastError

  while (true) {
    const current = followActive ? activeTab ?? lastTab : lastTab
    if (current.view.webContents.isDestroyed()) throw new Error(`controlled tab [${current.id}] is unavailable`)
    lastTab = current
    try {
      const state = await pageControl(current, 'get_browser_state', {})
      if (followActive && activeTab !== undefined && activeTab !== current) {
        candidateSince = undefined
        candidateUrl = undefined
        continue
      }
      lastState = state
      lastError = undefined
      const loading = current.view.webContents.isLoadingMainFrame()
      if (!waitForReady) return completeState(current, state, !loading)

      if (!loading && isUsableState(state)) {
        if (candidateUrl !== state.url) {
          candidateUrl = state.url
          candidateSince = Date.now()
        }
        if (Date.now() - candidateSince >= READINESS_SETTLE_MS) {
          return completeState(current, state, true)
        }
      } else {
        candidateSince = undefined
        candidateUrl = undefined
      }
    } catch (error) {
      if (!isNavigationInterruption(error) && !(waitForReady && isTransientPageStateError(error))) throw error
      lastError = error
      candidateSince = undefined
      candidateUrl = undefined
    }

    if (Date.now() >= deadline) {
      if (lastState !== undefined) return completeState(lastTab, lastState, false)
      throw lastError ?? new Error('page readiness timed out before a document could be observed')
    }
    await delay(Math.min(READINESS_POLL_MS, Math.max(1, deadline - Date.now())))
  }
}

ipcMain.on('page-control:result', (event, reply) => {
  const settle = pendingPageCalls.get(reply.id)
  // A reply for an id we already abandoned (navigation, timeout) is expected.
  if (!settle || event.sender !== settle.tab.view.webContents) return
  pendingPageCalls.delete(reply.id)
  if (reply.ok) settle.resolve(reply.result)
  else settle.reject(new Error(reply.error))
})

/** The isolated PageAgent runtime may only reach the host through this bridge. */
ipcMain.handle('page-agent:llm', async (event, request) => {
  const tab = Array.from(tabs.values()).find(candidate => candidate.view.webContents === event.sender)
  if (!tab) throw new Error('PageAgent request did not originate from a controlled tab')
  return await pageAgentLlm(tab, request)
})

/** The current HTTP(S) origin, or undefined for a non-web document. */
function httpOrigin(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

/** Whether a CDP node description is an HTML file input. */
function isFileInputNode(node) {
  if (node?.nodeName !== 'INPUT') return false
  const attributes = new Map()
  for (let index = 0; index < (node.attributes?.length ?? 0); index += 2) {
    attributes.set(node.attributes[index], node.attributes[index + 1])
  }
  return attributes.get('type')?.toLowerCase() === 'file'
}

/** Select one host-validated file through an indexed HTML file input. */
async function uploadFile(tab, args) {
  const contents = tab.view.webContents
  const origin = httpOrigin(contents.getURL())
  if (!origin) {
    return { success: false, message: '❌ File upload requires a currently observed HTTP(S) page.' }
  }
  const devtools = contents.debugger
  if (devtools.isAttached()) {
    return { success: false, message: '❌ File upload is unavailable while another debugger is attached.' }
  }

  try {
    devtools.attach('1.3')
    const point = await pageControl(tab, 'get_element_center', { index: args.index })
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      throw new Error('the indexed element has no usable viewport position')
    }
    const located = await devtools.sendCommand('DOM.getNodeForLocation', {
      x: point.x,
      y: point.y,
      ignorePointerEventsNone: true,
    })
    const hit = await devtools.sendCommand('DOM.describeNode', { backendNodeId: located.backendNodeId })
    if (!isFileInputNode(hit?.node)) throw new Error('the indexed element is not an HTML file input')
    if (!tabs.has(tab.id) || contents.isDestroyed() || httpOrigin(contents.getURL()) !== origin) {
      throw new Error('the target page origin changed before the file could be selected')
    }
    await devtools.sendCommand('DOM.setFileInputFiles', {
      files: [args.filePath],
      backendNodeId: located.backendNodeId,
    })
    return {
      success: true,
      message: `✅ Selected ${basename(args.filePath)} through element [${args.index}] on ${origin}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `❌ Failed to upload file through element [${args.index}]: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    if (devtools.isAttached()) {
      try {
        devtools.detach()
      } catch {}
    }
  }
}

/**
 * Run one protocol method. Navigation is the main process's own business;
 * everything else is a DOM action and belongs to the preload. Every method
 * answers in PageController's own `{success, message}` shape so the harness
 * never has to tell the two halves apart.
 * @param {string} method - protocol method name.
 * @param {Record<string, any>} args - JSON-safe method arguments.
 * @returns {Promise<unknown>} the JSON-safe result.
 */
async function handle(method, args) {
  if (method === 'open_new_tab') {
    const opened = createTab?.()
    if (!opened || !selectTab) throw new Error('tab controls are unavailable')
    selectTab(opened)
    if (args.url !== undefined) await opened.view.webContents.loadURL(args.url)
    return { success: true, message: `Opened tab [${opened.id}]${args.url === undefined ? '' : ` at ${opened.view.webContents.getURL()}`}.` }
  }
  if (method === 'switch_to_tab') {
    const target = tabs.get(args.tabId)
    if (!target || !selectTab) return { success: false, message: `No controlled tab has id [${args.tabId}].` }
    selectTab(target)
    return { success: true, message: `Switched to tab [${target.id}].` }
  }
  if (method === 'close_tab') {
    const target = tabs.get(args.tabId)
    if (!target || !closeTab) return { success: false, message: `No controlled tab has id [${args.tabId}].` }
    if (tabs.size === 1) return { success: false, message: 'The last controlled tab cannot be closed by the agent.' }
    closeTab(target)
    return { success: true, message: `Closed tab [${args.tabId}].` }
  }

  let tab
  if (args.tabId === undefined) {
    tab = activeTab
  } else {
    if (!Number.isSafeInteger(args.tabId) || args.tabId < 1) throw new Error('tabId must be a positive integer')
    tab = tabs.get(args.tabId)
  }
  if (!tab || tab.view.webContents.isDestroyed()) {
    throw new Error(args.tabId === undefined ? 'active tab is unavailable' : `controlled tab [${args.tabId}] is unavailable`)
  }
  const contents = tab.view.webContents
  switch (method) {
    case 'get_browser_state':
      return await readBrowserState(tab, args.waitForReady === true, args.tabId === undefined)

    case 'navigate':
      // Resolves on did-finish-load, so a caller that awaits this is talking to
      // the preload of the page it asked for, not the one it is leaving.
      await contents.loadURL(args.url)
      return { success: true, message: `Navigated to ${contents.getURL()}` }

    case 'back': {
      const history = contents.navigationHistory
      if (!history.canGoBack()) return { success: false, message: 'No earlier page in this view.' }
      const loaded = once(contents, 'did-finish-load')
      history.goBack()
      await loaded
      return { success: true, message: `Went back to ${contents.getURL()}` }
    }

    case 'forward': {
      const history = contents.navigationHistory
      if (!history.canGoForward()) return { success: false, message: 'No later page in this view.' }
      const loaded = once(contents, 'did-finish-load')
      history.goForward()
      await loaded
      return { success: true, message: `Went forward to ${contents.getURL()}` }
    }

    case 'reload':
      await contents.reload()
      return { success: true, message: `Reloaded ${contents.getURL()}` }

    case 'press':
      // The full triple: Chromium drops the `char` event for keys that produce
      // no text, and needs it for the ones that do — including Enter.
      contents.focus()
      for (const type of ['keyDown', 'char', 'keyUp']) {
        contents.sendInputEvent({ type, keyCode: args.key })
      }
      return { success: true, message: `Pressed ${args.key}` }

    case 'wait': {
      if (!Number.isFinite(args.seconds) || args.seconds < 1 || args.seconds > 10) {
        throw new Error('wait seconds must be between 1 and 10')
      }
      const lastUpdate = await pageControl(tab, 'get_last_update_time', {})
      const remaining = Math.max(0, args.seconds * 1_000 - (Date.now() - lastUpdate))
      await delay(remaining)
      return { success: true, message: `Waited up to ${args.seconds} second${args.seconds === 1 ? '' : 's'} for the page.` }
    }

    case 'execute_javascript':
      if (config.experimentalScriptExecution !== true) {
        throw new Error('experimental browser JavaScript is disabled by the host')
      }
      return await pageControl(tab, method, args)

    case 'upload_file':
      return await uploadFile(tab, args)

    default:
      try {
        return await pageControl(tab, method, args)
      } catch (error) {
        if (isNavigationInterruption(error)
          && ['click_element', 'input_text', 'select_option'].includes(method)) {
          return { success: true, message: `The ${method} action started a page navigation.` }
        }
        throw error
      }
  }
}

if (config.userDataDir && embedded === undefined) app.setPath('userData', config.userDataDir)

app.whenReady().then(async () => {
  browserSession = embedded === undefined
    ? session.defaultSession
    : session.fromPartition('persist:bh-controlled-browser')
  if (PERSIST_SESSION_COOKIES) {
    browserSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (!removed) persistSessionCookie(cookie)
    })
  }
  window = embedded?.window ?? new BrowserWindow({
    width: config.width ?? 1280,
    height: config.height ?? 900,
    show: config.show ?? true,
    title: 'Bosch Harness — controlled browser',
  })
  window.once('close', () => { windowClosing = true })

  chrome = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'chrome-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  window.contentView.addChildView(chrome)

  const fit = () => {
    const [windowWidth, windowHeight] = window.getContentSize()
    const panel = embedded === undefined
      ? { x: 0, y: 0, width: windowWidth, height: windowHeight, visible: true }
      : embeddedBounds
    const chromeHeight = Math.min(CHROME_HEIGHT, panel.height)
    chrome.setBounds({ x: panel.x, y: panel.y, width: panel.width, height: chromeHeight })
    chrome.setVisible(panel.visible && panel.width > 0 && chromeHeight > 0)
    for (const tab of tabs.values()) {
      tab.view.setBounds({
        x: panel.x,
        y: panel.y + chromeHeight,
        width: panel.width,
        height: Math.max(0, panel.height - chromeHeight),
      })
      tab.view.setVisible(panel.visible && activeTab === tab && panel.width > 0 && panel.height > chromeHeight)
    }
  }

  /** @returns {Tab} a hidden tab sharing the browser profile with every other tab. */
  createTab = function createControlledTab() {
    const tab = {
      id: nextTabId++,
      view: new WebContentsView({
        webPreferences: {
          preload: join(__dirname, 'preload.cjs'),
          session: browserSession,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      }),
    }
    tabs.set(tab.id, tab)
    window.contentView.addChildView(tab.view)
    tab.view.setVisible(false)

    const contents = tab.view.webContents
    contents.on('context-menu', (event, params) => {
      event.preventDefault()
      openPageMenu(tab, params)
    })
    contents.setWindowOpenHandler(({ url }) => {
      const opened = createTab?.()
      if (!opened || !selectTab) return { action: 'deny' }
      selectTab(opened)
      void opened.view.webContents.loadURL(url).catch(error => log('new-tab navigation failed:', error))
      return { action: 'deny' }
    })
    // Both ends of a document's life invalidate only the preload holding that
    // tab's indices; a background tab cannot cancel an active tab's action.
    contents.on('did-start-navigation', event => {
      if (!event.isMainFrame) return
      cancelAnnotation(tab)
      abortPageCalls(tab, 'page navigated away before the action completed')
      abortPageAgentLlmCalls(tab, 'page navigated away before PageAgent received a model response')
    })
    contents.on('render-process-gone', (_event, details) => {
      abortPageCalls(tab, `renderer gone: ${details.reason}`)
      abortPageAgentLlmCalls(tab, `renderer gone: ${details.reason}`)
    })
    contents.on('destroyed', () => {
      abortPageCalls(tab, 'tab renderer was destroyed')
      abortPageAgentLlmCalls(tab, 'tab renderer was destroyed')
      if (!tabs.delete(tab.id)) return
      if (windowClosing) return
      if (activeTab === tab) {
        activeTab = undefined
        const replacement = tabs.values().next().value
        if (replacement) selectTab(replacement)
        else if (embedded === undefined) window.close()
        else selectTab(createTab())
      } else {
        updateChrome()
      }
    })
    for (const event of ['did-finish-load', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
      contents.on(event, updateChrome)
    }
    return tab
  }

  /** Show a tab and make it the default target for actions without `tabId`. */
  selectTab = function selectControlledTab(tab) {
    if (windowClosing || !tabs.has(tab.id) || activeTab === tab || tab.view.webContents.isDestroyed()) return
    if (activeTab) {
      cancelAnnotation(activeTab)
      activeTab.view.setVisible(false)
    }
    activeTab = tab
    tab.view.setVisible(true)
    fit()
    tab.view.webContents.focus()
    updateChrome()
  }

  /** Close a tab, or the window when it is the last remaining tab. */
  closeTab = function closeControlledTab(tab) {
    if (windowClosing || !tabs.has(tab.id)) return
    if (tabs.size === 1) {
      if (embedded === undefined) window.close()
      return
    }

    const orderedTabs = Array.from(tabs.values())
    const index = orderedTabs.indexOf(tab)
    const replacement = orderedTabs[index + 1] ?? orderedTabs[index - 1]
    const wasActive = activeTab === tab
    cancelAnnotation(tab)
    abortPageCalls(tab, 'tab closed before the action completed')
    abortPageAgentLlmCalls(tab, 'tab closed before PageAgent received a model response')
    tabs.delete(tab.id)
    tab.view.setVisible(false)
    window.contentView.removeChildView(tab.view)
    if (wasActive) {
      activeTab = undefined
      selectTab(replacement)
    } else {
      updateChrome()
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  }

  const initialTab = createTab()
  selectTab(initialTab)
  if (chrome !== undefined) void chrome.webContents.loadFile(join(__dirname, 'chrome.html'))
  fit()
  window.on('resize', fit)
  chrome?.webContents.once('did-finish-load', updateChrome)

  // Load the configured home before accepting actions, so the first browser
  // state is useful and the persistent profile can resume its normal SSO flow.
  if (HOME_URL !== undefined) {
    try {
      await initialTab.view.webContents.loadURL(HOME_URL)
    } catch (error) {
      log('home navigation failed:', error)
    }
  }

  if (chrome !== undefined) {
    ipcMain.on('browser-chrome:navigate', (event, value) => {
      if (event.sender !== chrome.webContents) return
      if (typeof value !== 'string' || !value.trim()) return
      const tab = activeTab
      if (!tab) return
      void tab.view.webContents.loadURL(resolveOmnibox(value.trim())).catch(error => log('omnibox navigation failed:', error))
    })
    ipcMain.on('browser-chrome:back', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      const history = activeTab.view.webContents.navigationHistory
      if (history.canGoBack()) history.goBack()
    })
    ipcMain.on('browser-chrome:forward', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      const history = activeTab.view.webContents.navigationHistory
      if (history.canGoForward()) history.goForward()
    })
    ipcMain.on('browser-chrome:reload', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      activeTab.view.webContents.reload()
    })
    ipcMain.on('browser-chrome:new-tab', event => {
      if (event.sender === chrome.webContents) selectTab(createTab())
    })
    ipcMain.on('browser-chrome:select-tab', (event, id) => {
      if (event.sender !== chrome.webContents || !Number.isInteger(id)) return
      const tab = tabs.get(id)
      if (tab) selectTab(tab)
    })
    ipcMain.on('browser-chrome:close-tab', (event, id) => {
      if (event.sender !== chrome.webContents || !Number.isInteger(id)) return
      const tab = tabs.get(id)
      if (tab) closeTab(tab)
    })
  }

  /** Run one NDJSON request from either stdio or the desktop utility bridge. */
  const protocolRequest = async request => {
    const { id, method, args } = request
    if (method === 'page_agent_llm_response') {
      const pending = pendingPageAgentLlmCalls.get(args?.callId)
      if (pending === undefined) return undefined
      pendingPageAgentLlmCalls.delete(args.callId)
      if (args.ok === true) pending.resolve(args.result)
      else pending.reject(new Error(args.error ?? 'BH could not complete the PageAgent model request'))
      return undefined
    }
    try {
      return { id, ok: true, result: await handle(method, args ?? {}) }
    } catch (error) {
      return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  if (embedded !== undefined) {
    embedded.register({
      async command(method, args = {}) { return await handle(method, args) },
      getState() { return chromeState },
      async request(request) { return await protocolRequest(request) },
      setBounds(bounds) {
        if (windowClosing) return
        embeddedBounds = bounds
        fit()
      },
      async dispose() {
        windowClosing = true
        window.removeListener('resize', fit)
        for (const tab of tabs.values()) {
          abortPageCalls(tab, 'desktop browser closed before the action completed')
          abortPageAgentLlmCalls(tab, 'desktop browser closed before PageAgent received a model response')
          tab.view.setVisible(false)
          window.contentView.removeChildView(tab.view)
          if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
        }
        tabs.clear()
        activeTab = undefined
        chrome.setVisible(false)
        window.contentView.removeChildView(chrome)
        if (!chrome.webContents.isDestroyed()) chrome.webContents.close()
        await flushSessionCookies()
      },
    })
  } else {
    // Not `process.stdin`: in Electron's main process on Windows that is a stub
    // Readable that never emits, while reading fd 0 directly works everywhere.
    const input = createInterface({ input: createReadStream(null, { fd: 0, autoClose: false }) })
    input.on('line', line => {
      if (!line.trim()) return
      let request
      try {
        request = JSON.parse(line)
      } catch {
        // Nothing to reply to without an id, and throwing here would take the
        // process down over one bad line.
        log('unparseable request', JSON.stringify(line))
        return
      }
      void protocolRequest(request).then(reply => { if (reply !== undefined) send(reply) })
    })
    // The parent closing the pipe is the shutdown signal, so a killed harness
    // never leaves a window behind.
    input.on('close', () => {
      void flushSessionCookies().catch(error => log('session-cookie flush failed:', error)).finally(() => app.quit())
    })

    // The parent waits for this before sending anything; Electron's own startup
    // noise on stdout arrives before it and is skipped as unparseable.
    send({ event: 'ready' })
  }
})

// Closing the window by hand is a shutdown too: the parent sees the child exit
// and knows to spawn a fresh one next time.
if (embedded === undefined) app.on('window-all-closed', () => app.quit())
