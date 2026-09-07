// Electron main process for the harness's embedded browser. Spawned by
// `@hydra/harness-browser-electron`; it owns one window holding controlled tab views
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
const { randomUUID } = require('node:crypto')
const { createReadStream, existsSync } = require('node:fs')
const { readFile, rename, writeFile } = require('node:fs/promises')
const { createInterface } = require('node:readline')
const { basename, isAbsolute, join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, session, shell } = require('electron')

const { createAutofillVault } = require('./autofill-vault.cjs')

/**
 * The desktop shell may host this controller in-process. Standalone launches
 * keep the original argv/stdout protocol used by BrowserSessionService.
 */
const embedded = globalThis.__HYDRA_BROWSER_EMBED__
/** Config from the parent, or defaults when run by hand for a smoke test. */
const config = embedded?.config ?? JSON.parse(process.argv[2] ?? '{}')
const CHROME_HEIGHT = 96
const READINESS_TIMEOUT_MS = config.readinessTimeoutMs ?? 45_000
const READINESS_POLL_MS = 250
const READINESS_SETTLE_MS = 500

/** Optional profile-owned home page; config validation happens in the parent. */
const HOME_URL = typeof config.homeUrl === 'string' && config.homeUrl.length > 0 ? config.homeUrl : undefined
const PERSIST_SESSION_COOKIES = config.persistSessionCookies === true
const SESSION_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60
const PROFILE_STORE_FILE = 'browser-management.json'
const AUTOFILL_STORE_FILE = 'browser-autofill.json'
const AUTOFILL_UNAVAILABLE_REASON = 'Secure autofill storage is unavailable on this device.'
const MAX_HISTORY_ENTRIES = 1_000
const MAX_DOWNLOAD_ENTRIES = 500
const MAX_SITE_ENTRIES = 500
const DECISIONS = new Set(['allow', 'ask', 'block'])
const DESTINATIONS = new Set(['hydra', 'system'])
const ANNOTATION_SCREENSHOTS = new Set(['include', 'ask', 'never'])
const CLEAR_DATA_SCOPES = new Set(['all', 'history', 'site-data', 'cache', 'downloads'])
const SITE_DATA_TYPES = ['cookies', 'backgroundFetch', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL']
const MAX_HISTORY_SEARCH_RESULTS = 20
const MAX_SCREENSHOT_BYTES = 3_500_000
const MAX_SCREENSHOT_EDGE = 2_000
const MAX_CDP_PARAMS_BYTES = 64 * 1_024
const MAX_CDP_RESULT_BYTES = 1_024 * 1_024
const MAX_CDP_EVENT_RESULTS = 100
const MAX_CDP_EVENT_ENTRIES = 1_000
const MAX_CDP_EVENT_BYTES = 64 * 1_024
const MAX_CDP_EVENT_RING_BYTES = 4 * 1_024 * 1_024
const CDP_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u
const CROSS_TARGET_CDP_DOMAINS = new Set(['Browser', 'SystemInfo', 'Target', 'Tethering'])

/** Preferences enforced by the Electron owner, updated through validated commands. */
const nativeSettings = {
  webDestination: DESTINATIONS.has(config.webDestination) ? config.webDestination : 'hydra',
  localDestination: DESTINATIONS.has(config.localDestination) ? config.localDestination : 'hydra',
  annotationScreenshots: ANNOTATION_SCREENSHOTS.has(config.annotationScreenshots)
    ? config.annotationScreenshots : 'include',
  downloadDirectory: typeof config.downloadDirectory === 'string' ? config.downloadDirectory : '',
  askWhereToSave: config.askWhereToSave === true,
  navigationPolicy: DECISIONS.has(config.navigationPolicy)
    ? config.navigationPolicy
    : embedded === undefined ? 'allow' : 'ask',
  downloadPolicy: DECISIONS.has(config.downloadPolicy)
    ? config.downloadPolicy
    : embedded === undefined ? 'allow' : 'ask',
  fullCdpAccessAllowed: config.fullCdpAccessAllowed !== false,
  fullCdpAccess: config.fullCdpAccess === true,
}

/** App-owned browsing records; Chromium exposes neither durable history manager. */
let profileStore = { history: [], downloads: [], sites: {} }
let profileStorePath
let profileStoreWrite = Promise.resolve()
const reservedDownloadPaths = new Set()

/** Pending native cookie-store writes, flushed before a harness-owned exit. */
const sessionCookieWrites = new Set()
/** Controlled pages share one Chromium session, isolated from the app renderer. */
let browserSession
/** Main-process-only encrypted credentials and contact information. */
let autofillVault
let autofillUnavailableReason = AUTOFILL_UNAVAILABLE_REASON

const log = (...parts) => console.error('[hydra-browser]', ...parts)

function boundedString(value, max) {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

/** Canonical exact HTTP(S) origin used by navigation and permission policy. */
function canonicalOrigin(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

/** Match the preload's privacy-preserving annotation page address. */
function annotationPageUrl(value) {
  const url = routedHttpUrl(value)
  if (url === undefined) return undefined
  url.search = ''
  url.hash = ''
  return url.href
}

function validDecision(value) {
  return DECISIONS.has(value) ? value : undefined
}

function validDestination(value) {
  return DESTINATIONS.has(value) ? value : undefined
}

function validAnnotationScreenshots(value) {
  return ANNOTATION_SCREENSHOTS.has(value) ? value : undefined
}

function clearDataScope(value) {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new Error('clear data scope must be an object')
  }
  const scope = value?.scope ?? 'all'
  if (!CLEAR_DATA_SCOPES.has(scope)) {
    throw new Error('clear data scope must be all, history, site-data, cache, or downloads')
  }
  return scope
}

function historyEntry(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const id = boundedString(value.id, 100)
  const url = boundedString(value.url, 2_048)
  const title = boundedString(value.title, 512)
  const visitedAt = boundedString(value.visitedAt, 64)
  if (!id || !url || title === undefined || !visitedAt || canonicalOrigin(url) === undefined) return undefined
  return { id, url, title, visitedAt }
}

function downloadEntry(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const id = boundedString(value.id, 100)
  const url = boundedString(value.url, 2_048)
  const filename = boundedString(value.filename, 512)
  const path = boundedString(value.path, 32_768)
  const state = ['progressing', 'completed', 'cancelled', 'interrupted'].includes(value.state)
    ? value.state : undefined
  const startedAt = boundedString(value.startedAt, 64)
  const endedAt = value.endedAt === undefined ? undefined : boundedString(value.endedAt, 64)
  if (!id || !url || !filename || path === undefined || !state || !startedAt) return undefined
  return { id, url, filename, path, state, startedAt, ...(endedAt === undefined ? {} : { endedAt }) }
}

function siteEntry(origin, value) {
  const normalized = canonicalOrigin(origin)
  if (normalized !== origin || typeof value !== 'object' || value === null) return undefined
  const access = validDecision(value.access)
  const media = validDecision(value.media)
  if (access !== 'allow' && access !== 'block') return undefined
  if (media !== 'allow' && media !== 'block') return undefined
  return { origin, access, media }
}

/** Parse only the bounded app-owned records from a durable profile file. */
function profileStoreOf(value) {
  if (typeof value !== 'object' || value === null) return { history: [], downloads: [], sites: {} }
  const history = Array.isArray(value.history)
    ? value.history.slice(0, MAX_HISTORY_ENTRIES).flatMap(entry => historyEntry(entry) ?? [])
    : []
  const downloads = Array.isArray(value.downloads)
    ? value.downloads.slice(0, MAX_DOWNLOAD_ENTRIES).flatMap(entry => downloadEntry(entry) ?? [])
    : []
  const sites = {}
  if (typeof value.sites === 'object' && value.sites !== null) {
    for (const [origin, candidate] of Object.entries(value.sites).slice(0, MAX_SITE_ENTRIES)) {
      const entry = siteEntry(origin, candidate)
      if (entry !== undefined) sites[origin] = { access: entry.access, media: entry.media }
    }
  }
  return { history, downloads, sites }
}

async function loadProfileStore() {
  profileStorePath = join(app.getPath('userData'), PROFILE_STORE_FILE)
  try {
    profileStore = profileStoreOf(JSON.parse(await readFile(profileStorePath, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') log('profile management store ignored:', error)
  }
}

/** Open and validate the encrypted vault without making browser startup depend on it. */
async function initializeAutofillVault() {
  try {
    const candidate = createAutofillVault({
      filename: join(app.getPath('userData'), AUTOFILL_STORE_FILE),
      safeStorage,
    })
    await Promise.all([candidate.listLogins(), candidate.listContacts()])
    autofillVault = candidate
    autofillUnavailableReason = undefined
  } catch {
    autofillVault = undefined
    autofillUnavailableReason = AUTOFILL_UNAVAILABLE_REASON
    log('secure autofill is unavailable')
  }
}

function autofillStatus() {
  return autofillVault === undefined
    ? { available: false, reason: autofillUnavailableReason ?? AUTOFILL_UNAVAILABLE_REASON }
    : { available: true }
}

async function useAutofillVault(operation) {
  const vault = autofillVault
  if (vault === undefined) throw new Error(autofillUnavailableReason ?? AUTOFILL_UNAVAILABLE_REASON)
  try {
    return await operation(vault)
  } catch (error) {
    if (error?.code === 'AUTOFILL_VAULT_UNAVAILABLE') {
      autofillVault = undefined
      autofillUnavailableReason = AUTOFILL_UNAVAILABLE_REASON
    }
    throw error
  }
}

function persistProfileStore() {
  const snapshot = JSON.stringify({ version: 1, ...profileStore })
  profileStoreWrite = profileStoreWrite.catch(() => undefined).then(async () => {
    const temporary = `${profileStorePath}.tmp`
    await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, profileStorePath)
  })
  void profileStoreWrite.catch(error => log('profile management store write failed:', error))
  return profileStoreWrite
}

function configureBrowserSettings(value) {
  if (typeof value !== 'object' || value === null) throw new Error('Browser settings are invalid')
  const directory = value.downloadDirectory
  if (typeof directory !== 'string' || (directory !== '' && !isAbsolute(directory))) {
    throw new Error('download directory must be empty or absolute')
  }
  const navigationPolicy = validDecision(value.navigationPolicy)
  const downloadPolicy = validDecision(value.downloadPolicy)
  if (navigationPolicy === undefined || downloadPolicy === undefined || typeof value.askWhereToSave !== 'boolean') {
    throw new Error('Browser permission settings are invalid')
  }
  nativeSettings.downloadDirectory = directory
  nativeSettings.askWhereToSave = value.askWhereToSave
  nativeSettings.navigationPolicy = navigationPolicy
  nativeSettings.downloadPolicy = downloadPolicy
  if (value.webDestination !== undefined) {
    const destination = validDestination(value.webDestination)
    if (destination === undefined) throw new Error('web destination must be hydra or system')
    nativeSettings.webDestination = destination
  }
  if (value.localDestination !== undefined) {
    const destination = validDestination(value.localDestination)
    if (destination === undefined) throw new Error('local destination must be hydra or system')
    nativeSettings.localDestination = destination
  }
  if (value.annotationScreenshots !== undefined) {
    const screenshots = validAnnotationScreenshots(value.annotationScreenshots)
    if (screenshots === undefined) throw new Error('annotation screenshot policy is invalid')
    nativeSettings.annotationScreenshots = screenshots
  }
  if (value.fullCdpAccessAllowed !== undefined) {
    if (typeof value.fullCdpAccessAllowed !== 'boolean') throw new Error('full CDP organization policy is invalid')
    nativeSettings.fullCdpAccessAllowed &&= value.fullCdpAccessAllowed
  }
  if (value.fullCdpAccess !== undefined) {
    if (typeof value.fullCdpAccess !== 'boolean') throw new Error('full CDP setting is invalid')
    nativeSettings.fullCdpAccess = value.fullCdpAccess
  }
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess) {
    for (const tab of tabs.values()) detachTabDebugger(tab, true)
  }
  if (browserSession !== undefined) browserSession.setDownloadPath(directory || app.getPath('downloads'))
  return { fullCdpAccessAllowed: nativeSettings.fullCdpAccessAllowed }
}

function recordHistory(contents) {
  let url
  try {
    const parsed = new URL(contents.getURL())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    parsed.username = ''
    parsed.password = ''
    url = parsed.href
  } catch {
    return
  }
  const now = new Date().toISOString()
  const current = profileStore.history[0]
  const entry = { id: current?.url === url ? current.id : randomUUID(), url, title: contents.getTitle() || url, visitedAt: now }
  if (current?.url === url) profileStore.history[0] = entry
  else profileStore.history.unshift(entry)
  profileStore.history.length = Math.min(profileStore.history.length, MAX_HISTORY_ENTRIES)
  persistProfileStore()
}

function searchHistory(value) {
  const query = typeof value?.query === 'string' ? boundedString(value.query.trim(), 256) : undefined
  const limit = value?.limit
  if (!query) throw new Error('history query must contain 1 to 256 characters')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_SEARCH_RESULTS) {
    throw new Error(`history search limit must be from 1 to ${MAX_HISTORY_SEARCH_RESULTS}`)
  }
  const needle = query.toLocaleLowerCase()
  return profileStore.history
    .filter(entry => `${entry.title}\n${entry.url}`.toLocaleLowerCase().includes(needle))
    .slice(0, limit)
    .map(({ url, title, visitedAt }) => ({ url, title, visitedAt }))
}

function listSites() {
  return Object.entries(profileStore.sites)
    .map(([origin, value]) => ({ origin, access: value.access, media: value.media }))
    .sort((left, right) => left.origin.localeCompare(right.origin))
}

async function setSite(value) {
  const origin = canonicalOrigin(value?.origin)
  if (origin === undefined) throw new Error('site must be an absolute HTTP(S) URL')
  const access = validDecision(value.access)
  const media = validDecision(value.media)
  if (access !== 'allow' && access !== 'block') throw new Error('site access must be allow or block')
  if (media !== 'allow' && media !== 'block') throw new Error('site media must be allow or block')
  if (!Object.hasOwn(profileStore.sites, origin) && Object.keys(profileStore.sites).length >= MAX_SITE_ENTRIES) {
    throw new Error(`site override limit of ${MAX_SITE_ENTRIES} reached`)
  }
  const previous = profileStore.sites[origin]
  profileStore.sites[origin] = { access, media }
  const persisted = persistProfileStore()
  if (media === 'block' && previous?.media !== 'block') await revokeMediaForOrigin(origin)
  await persisted
}

function removeSite(value) {
  const origin = canonicalOrigin(value?.origin)
  if (origin === undefined) throw new Error('site must be an absolute HTTP(S) URL')
  delete profileStore.sites[origin]
  persistProfileStore()
}

function uniqueDownloadPath(directory, filename) {
  const parsed = basename(filename)
  const dot = parsed.lastIndexOf('.')
  const stem = dot > 0 ? parsed.slice(0, dot) : parsed
  const extension = dot > 0 ? parsed.slice(dot) : ''
  let candidate = join(directory, parsed)
  for (let suffix = 1; existsSync(candidate) || reservedDownloadPaths.has(candidate); suffix += 1) {
    candidate = join(directory, `${stem} (${suffix})${extension}`)
  }
  return candidate
}

function updateDownload(id, patch) {
  const index = profileStore.downloads.findIndex(entry => entry.id === id)
  if (index === -1) return
  profileStore.downloads[index] = { ...profileStore.downloads[index], ...patch }
  persistProfileStore()
}

/** Enforce download policy before data reaches disk and retain a bounded ledger. */
function beginDownload(event, item) {
  const id = randomUUID()
  const directory = nativeSettings.downloadDirectory || app.getPath('downloads')
  const filename = basename(item.getFilename())
  const proposedPath = uniqueDownloadPath(directory, filename)
  reservedDownloadPaths.add(proposedPath)
  const entry = {
    id,
    url: item.getURL(),
    filename,
    path: nativeSettings.askWhereToSave ? '' : proposedPath,
    state: 'progressing',
    startedAt: new Date().toISOString(),
  }
  profileStore.downloads.unshift(entry)
  profileStore.downloads.length = Math.min(profileStore.downloads.length, MAX_DOWNLOAD_ENTRIES)

  let allowed = nativeSettings.downloadPolicy === 'allow'
  if (nativeSettings.downloadPolicy === 'ask' && window !== undefined && !windowClosing) {
    allowed = dialog.showMessageBoxSync(window, {
      type: 'question',
      title: 'Download permission',
      message: `Download ${filename}?`,
      detail: `Source: ${item.getURL()}`,
      buttons: ['Download', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }) === 0
  }
  if (!allowed) {
    reservedDownloadPaths.delete(proposedPath)
    event.preventDefault()
    updateDownload(id, { state: 'cancelled', endedAt: new Date().toISOString() })
    return
  }

  if (nativeSettings.askWhereToSave) item.setSaveDialogOptions({ defaultPath: proposedPath })
  else item.setSavePath(proposedPath)
  persistProfileStore()
  item.on('updated', () => {
    updateDownload(id, { state: item.getState(), path: item.getSavePath() || entry.path })
  })
  item.once('done', (_event, state) => {
    reservedDownloadPaths.delete(proposedPath)
    updateDownload(id, { state, path: item.getSavePath() || entry.path, endedAt: new Date().toISOString() })
  })
}

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

/** In-flight PageAgent model requests awaiting the owning Hydra agent. */
const pendingPageAgentLlmCalls = new Map()
let nextPageAgentLlmCallId = 1

/** @typedef {{ id: number, view: import('electron').WebContentsView, contents: import('electron').WebContents, favicon?: string, cdp: { owned: boolean, persistent: boolean, nextSequence: number, events: Array<object>, bytes: number } }} Tab */

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
/** Status line shown in native chrome while the agent drives the page. */
let chromeActivity = ''
/** Whether an agent browser action has already revealed the desktop panel. */
let agentBrowserRevealed = false
/** Toolbar picker whose completion owns the pressed-state reset. */
let toolbarAnnotation
let windowClosing = false
/** @type {(() => Tab) | undefined} */
let createTab
/** @type {((tab: Tab) => void) | undefined} */
let selectTab
/** @type {((tab: Tab) => void) | undefined} */
let closeTab

function isControlledContents(contents) {
  return Array.from(tabs.values()).some(tab => tab.view.webContents === contents)
}

/** Attach the tab-scoped debugger once and retain it only for full CDP. */
function ensureTabDebugger(tab, persistent) {
  const devtools = tab.view.webContents.debugger
  if (tab.cdp.owned && devtools.isAttached()) {
    tab.cdp.persistent ||= persistent
    return false
  }
  tab.cdp.owned = false
  tab.cdp.persistent = false
  if (devtools.isAttached()) throw new Error('the controlled tab debugger is already in use')
  devtools.attach('1.3')
  tab.cdp.owned = true
  tab.cdp.persistent = persistent
  return true
}

/** Release only a debugger attachment owned by this controller. */
function detachTabDebugger(tab, clear) {
  const contents = tab.contents
  const owned = tab.cdp.owned
  tab.cdp.owned = false
  tab.cdp.persistent = false
  if (clear) {
    tab.cdp.events = []
    tab.cdp.bytes = 0
  }
  if (!owned || contents.isDestroyed()) return
  const devtools = contents.debugger
  if (!devtools.isAttached()) return
  try {
    devtools.detach()
  } catch {}
}

/** Retain a bounded, tab-local event stream without cross-target domains. */
function recordCdpEvent(tab, method, params) {
  if (!tab.cdp.owned || !tab.cdp.persistent || typeof method !== 'string' || !CDP_METHOD.test(method)
    || CROSS_TARGET_CDP_DOMAINS.has(method.slice(0, method.indexOf('.')))
    || typeof params !== 'object' || params === null || Array.isArray(params)) return
  const sequence = tab.cdp.nextSequence++
  const event = { sequence, method, params, receivedAt: new Date().toISOString() }
  let bytes
  try {
    bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
  } catch {
    return
  }
  if (bytes > MAX_CDP_EVENT_BYTES) return
  tab.cdp.events.push({ ...event, bytes })
  tab.cdp.bytes += bytes
  while (tab.cdp.events.length > MAX_CDP_EVENT_ENTRIES || tab.cdp.bytes > MAX_CDP_EVENT_RING_BYTES) {
    tab.cdp.bytes -= tab.cdp.events.shift().bytes
  }
}

function reloadFrame(frame) {
  return new Promise((resolve) => {
    const ready = () => { resolve() }
    frame.once('dom-ready', ready)
    if (frame.reload()) return
    frame.removeListener('dom-ready', ready)
    resolve()
  })
}

/** Destroy documents holding media tracks before a new block is acknowledged. */
async function revokeMediaForOrigin(origin) {
  await Promise.all(Array.from(tabs.values(), async (tab) => {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    await Promise.all(contents.mainFrame.framesInSubtree.map(async (frame) => {
      if (frame.detached || frame.origin !== origin) return
      await reloadFrame(frame)
    }))
  }))
}

function siteNavigationBlocked(targetUrl) {
  const origin = canonicalOrigin(targetUrl)
  return origin !== undefined && profileStore.sites[origin]?.access === 'block'
}

/** Decide one cross-origin navigation at the Electron boundary. */
function navigationAllowed(contents, targetUrl) {
  if (targetUrl === 'about:blank') return true
  const origin = canonicalOrigin(targetUrl)
  if (origin === undefined) return false
  const existing = profileStore.sites[origin]
  if (siteNavigationBlocked(targetUrl)) return false
  if (canonicalOrigin(contents.getURL()) === origin) return true
  const policy = existing?.access ?? nativeSettings.navigationPolicy
  if (policy === 'allow') return true
  if (policy === 'block' || window === undefined || windowClosing) return false
  const choice = dialog.showMessageBoxSync(window, {
    type: 'question',
    title: 'Website permission',
    message: `Allow the built-in Browser to open ${origin}?`,
    detail: 'Website content is untrusted. Allow it once, remember this site, or block it.',
    buttons: ['Allow once', 'Always allow', 'Block'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (choice === 1) {
    profileStore.sites[origin] = { access: 'allow', media: existing?.media ?? 'block' }
    persistProfileStore()
  } else if (choice === 2) {
    profileStore.sites[origin] = { access: 'block', media: existing?.media ?? 'block' }
    persistProfileStore()
  }
  return choice !== 2
}

async function loadAllowedUrl(contents, targetUrl) {
  if (!navigationAllowed(contents, targetUrl)) {
    throw new Error(`navigation to ${targetUrl} was blocked by Browser settings`)
  }
  await contents.loadURL(targetUrl)
}

function mediaPermissionAllowed(contents, origin, prompt) {
  if (!isControlledContents(contents)) return false
  const normalized = canonicalOrigin(origin)
  if (normalized === undefined) return false
  const existing = profileStore.sites[normalized]
  if (existing?.media === 'allow') return true
  if (existing?.media === 'block' || !prompt || window === undefined || windowClosing) return false
  const choice = dialog.showMessageBoxSync(window, {
    type: 'question',
    title: 'Camera and microphone permission',
    message: `Allow ${normalized} to use camera or microphone?`,
    detail: 'Only grant this to a website you trust.',
    buttons: ['Allow once', 'Always allow', 'Block'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  })
  if (choice === 1 || choice === 2) {
    profileStore.sites[normalized] = {
      access: existing?.access ?? 'block',
      media: choice === 1 ? 'allow' : 'block',
    }
    persistProfileStore()
  }
  return choice !== 2
}

function historyDestination(contents, offset) {
  const history = contents.navigationHistory
  return history.getEntryAtIndex(history.getActiveIndex() + offset)?.url
}

function moveInHistory(contents, offset) {
  const targetUrl = historyDestination(contents, offset)
  if (targetUrl === undefined || siteNavigationBlocked(targetUrl)) return false
  contents.navigationHistory.goToIndex(contents.navigationHistory.getActiveIndex() + offset)
  return true
}

function reloadAllowed(contents) {
  if (siteNavigationBlocked(contents.getURL())) return false
  contents.reload()
  return true
}

/** Resolve an omnibox entry as an address when possible, otherwise a search. */
function resolveOmnibox(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch {}
  if (/^(?:localhost|[^\s/.]+(?:\.[^\s/.]+)+)(?::\d+)?(?:[/?#].*)?$/u.test(value)) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

/** Validate a user-opened app link and remove URL credentials before routing it. */
function routedHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.username = ''
    url.password = ''
    return url
  } catch {
    return undefined
  }
}

function isLoopbackUrl(url) {
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  const octets = host.split('.')
  return octets.length === 4 && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
}

/** Route a URL opened by the trusted desktop renderer, never a controlled page. */
async function routeUserUrl(value) {
  const url = routedHttpUrl(value)
  if (url === undefined) throw new Error('desktop Browser routing accepts only absolute HTTP(S) URLs')
  const destination = isLoopbackUrl(url) ? nativeSettings.localDestination : nativeSettings.webDestination
  if (destination === 'system') {
    await shell.openExternal(url.href)
    return { success: true, destination, url: url.href }
  }
  if (!activeTab || !createTab || !selectTab || !navigationAllowed(activeTab.view.webContents, url.href)) {
    throw new Error(`navigation to ${url.href} was blocked by Browser settings`)
  }
  const opened = createTab()
  selectTab(opened)
  try {
    await opened.view.webContents.loadURL(url.href)
  } catch (error) {
    if (tabs.size > 1 && closeTab) closeTab(opened)
    throw error
  }
  embedded?.openBrowser?.()
  return { success: true, destination, url: opened.view.webContents.getURL() }
}

function isProfileManagement(method) {
  return method === 'configure_browser'
    || method === 'clear_browser_data'
    || method.startsWith('autofill_')
    || method === 'browser_history'
    || method === 'search_browser_history'
    || method === 'remove_browser_history'
    || method === 'browser_downloads'
    || method === 'remove_browser_download'
    || method === 'browser_sites'
    || method === 'set_browser_site'
    || method === 'remove_browser_site'
    || method === 'route_user_url'
    || method === 'page_agent_llm_response'
}

function agentChromeActivity(method, args) {
  switch (method) {
    case 'click_element':
      return typeof args.index === 'number' ? `Hydra: Click [${args.index}]` : `Hydra: Click ${args.name ?? 'element'}`
    case 'input_text':
      return typeof args.index === 'number' ? `Hydra: Type into [${args.index}]` : `Hydra: Type into ${args.name ?? 'field'}`
    case 'select_option':
      return typeof args.index === 'number' ? `Hydra: Select in [${args.index}]` : `Hydra: Select ${args.name ?? 'option'}`
    case 'fill_fields':
      return 'Hydra: Fill form'
    case 'find_element':
      return `Hydra: Find ${args.query ?? 'control'}`
    case 'navigate':
      return 'Hydra: Navigate'
    case 'back':
      return 'Hydra: Back'
    case 'forward':
      return 'Hydra: Forward'
    case 'scroll':
    case 'scroll_horizontally':
      return 'Hydra: Scroll'
    case 'press':
      return `Hydra: Press ${args.key}`
    case 'wait':
      return 'Hydra: Wait'
    case 'open_new_tab':
      return 'Hydra: Open tab'
    case 'switch_to_tab':
      return 'Hydra: Switch tab'
    case 'close_tab':
      return 'Hydra: Close tab'
    case 'upload_file':
      return typeof args.index === 'number' ? `Hydra: Upload through [${args.index}]` : 'Hydra: Upload file'
    case 'page_agent_run':
      return 'Hydra: PageAgent'
    case 'page_agent_stop':
      return 'Hydra: Stop PageAgent'
    default:
      return `Hydra: ${method}`
  }
}

function noteAgentBrowser(method, args) {
  if (isProfileManagement(method)) return
  if (!agentBrowserRevealed) {
    agentBrowserRevealed = true
    embedded?.openBrowser?.()
  }
  if (
    method === 'get_browser_state'
    || method === 'get_upload_target'
    || method === 'get_cdp_target'
    || method === 'browser_screenshot'
    || method === 'cdp_command'
    || method === 'cdp_read_events'
  ) {
    return
  }
  chromeActivity = agentChromeActivity(method, args)
  updateChrome()
}

/** Keep the native browser chrome in sync with every tab and the selected page. */
function updateChrome() {
  if (windowClosing || !activeTab) return
  const contents = activeTab.view.webContents
  if (contents.isDestroyed()) return
  const url = contents.getURL()
  chromeState = {
    tabs: Array.from(tabs.values(), tab => ({
      id: tab.id,
      title: tab.view.webContents.getTitle() || 'New Tab',
      favicon: tab.favicon ?? '',
    })),
    activeTabId: activeTab.id,
    url,
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    history: profileStore.history.slice(0, MAX_HISTORY_SEARCH_RESULTS)
      .map(({ title, url: entryUrl }) => ({ title, url: entryUrl })),
    annotationEnabled: typeof embedded?.onAnnotation === 'function',
    loading: contents.isLoading(),
    secure: url.startsWith('https:'),
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    activity: chromeActivity,
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

/** Ask the owning Hydra process to run one PageAgent model step. */
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
  if (typeof value !== 'object' || value === null
    || (value.kind !== 'browser-element' && value.kind !== 'browser-region')
    || typeof value.url !== 'string' || typeof value.title !== 'string' || typeof value.preview !== 'string') return undefined
  if (value.url.length > 2_048 || annotationPageUrl(value.url) !== value.url
    || value.title.length > 160 || value.preview.length > 1_024) return undefined
  if (value.index !== undefined && (!Number.isInteger(value.index) || value.index < 0)) return undefined
  let rect
  if (value.rect !== undefined) {
    if (typeof value.rect !== 'object' || value.rect === null) return undefined
    const { x, y, width, height } = value.rect
    if (![x, y, width, height].every(Number.isSafeInteger)
      || x < 0 || y < 0 || width < 1 || height < 1 || width > 10_000 || height > 10_000) return undefined
    rect = { x, y, width, height }
  }
  if (value.kind === 'browser-region' && (value.index !== undefined || rect === undefined)) return undefined
  return {
    kind: value.kind,
    url: value.url,
    title: value.title,
    preview: value.preview,
    ...(value.index === undefined ? {} : { index: value.index }),
    ...(rect === undefined ? {} : { rect }),
  }
}

/**
 * Copy pixels from the renderer when the OS compositor has no display surface.
 * @param {Electron.WebContents} contents
 * @param {{ x: number, y: number, width: number, height: number } | undefined} rect
 * @returns {Promise<Electron.NativeImage | undefined>}
 */
async function captureViaCdp(contents, rect) {
  const debug = contents.debugger
  const attached = debug.isAttached()
  try {
    if (!attached) debug.attach('1.3')
    const params = { format: 'png', fromSurface: false }
    if (rect !== undefined) {
      params.clip = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: 1,
      }
    }
    const result = await debug.sendCommand('Page.captureScreenshot', params)
    if (typeof result?.data !== 'string' || result.data.length === 0) return undefined
    const image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'))
    return image.isEmpty() ? undefined : image
  } catch {
    // Renderer screenshot is a fallback when the OS compositor has no surface.
    return undefined
  } finally {
    if (!attached && debug.isAttached()) {
      try {
        debug.detach()
      } catch {
        // The tab closed before the fallback debugger could detach.
      }
    }
  }
}

/** Capture one viewport/region as a bounded PNG; callers decide whether refusal is fatal. */
async function boundedPng(contents, rect) {
  const capture = stayHidden => (rect === undefined
    ? contents.capturePage({ stayHidden })
    : contents.capturePage(rect, { stayHidden }))
  let image
  try {
    image = await capture(false)
  } catch {
    // Hidden WebContentsView has no compositor surface until a shown capture.
  }
  if (image === undefined || image.isEmpty()) {
    try {
      image = await capture(true)
    } catch {
      // stayHidden copy can miss the same absent surface; retry from the renderer.
    }
  }
  if (image === undefined || image.isEmpty()) {
    image = await captureViaCdp(contents, rect)
  }
  if (image === undefined || image.isEmpty()) return undefined
  let size = image.getSize()
  if (Math.max(size.width, size.height) > MAX_SCREENSHOT_EDGE) {
    const scale = MAX_SCREENSHOT_EDGE / Math.max(size.width, size.height)
    image = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    })
    size = image.getSize()
  }
  const png = image.toPNG()
  if (png.length > MAX_SCREENSHOT_BYTES) return undefined
  return { data: png.toString('base64'), bytes: png.length, width: size.width, height: size.height }
}

async function annotationScreenshot(contents, rect) {
  if (rect === undefined) return undefined
  const screenshot = await boundedPng(contents, rect)
  return screenshot === undefined ? undefined : { mediaType: 'image/png', data: screenshot.data }
}

/** Insert one selected element or region into the desktop's main composer. */
async function publishAnnotation(tab, action, args) {
  try {
    const selected = annotationOf(await pageControl(tab, action, args))
    if (selected === undefined || activeTab !== tab) return
    const contents = tab.view.webContents
    const expectedOrigin = canonicalOrigin(selected.url)
    if (contents.isDestroyed() || annotationPageUrl(contents.getURL()) !== selected.url) return
    let includeScreenshot = nativeSettings.annotationScreenshots === 'include'
    if (nativeSettings.annotationScreenshots === 'ask' && window !== undefined && !windowClosing) {
      const target = selected.kind === 'browser-region' ? 'page region' : 'page element'
      includeScreenshot = dialog.showMessageBoxSync(window, {
        type: 'question',
        title: 'Include annotation screenshot?',
        message: `Attach a screenshot of the selected ${target}?`,
        detail: `Page: ${expectedOrigin}`,
        buttons: ['Include screenshot', 'Text only'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }) === 0
    }
    let screenshot
    if (includeScreenshot) {
      try {
        screenshot = await annotationScreenshot(contents, selected.rect)
      } catch (error) {
        log('annotation screenshot failed:', error)
      }
    }
    if (activeTab !== tab || contents.isDestroyed() || annotationPageUrl(contents.getURL()) !== selected.url) return
    embedded?.onAnnotation?.({ ...selected, ...(screenshot === undefined ? {} : { screenshot }) })
  } catch (error) {
    if (!isNavigationInterruption(error)) log('annotation failed:', error)
  }
}

function stillOnOrigin(tab, origin) {
  const contents = tab.view.webContents
  return activeTab === tab && tabs.has(tab.id) && !contents.isDestroyed() && httpOrigin(contents.getURL()) === origin
}

function autofillMenuLabel(value, fallback) {
  if (typeof value !== 'string') return fallback
  return value.replace(/\s+/gu, ' ').trim().slice(0, 160) || fallback
}

async function fillSavedLogin(tab, origin, id, point) {
  if (!stillOnOrigin(tab, origin)) return
  try {
    const login = await useAutofillVault(vault => vault.resolveLogin(id))
    if (login === undefined || login.origin !== origin || !stillOnOrigin(tab, origin)) return
    await pageControl(tab, 'autofill_login', {
      expectedOrigin: origin,
      username: login.username,
      password: login.password,
      ...point,
    })
  } catch (error) {
    if (!isNavigationInterruption(error)) log('saved login could not be filled')
  }
}

async function fillSavedContact(tab, origin, id, point) {
  if (!stillOnOrigin(tab, origin) || window === undefined || windowClosing) return
  const confirmed = dialog.showMessageBoxSync(window, {
    type: 'question',
    title: 'Fill contact information?',
    message: `Fill saved contact information on ${origin}?`,
    detail: 'Only fields with standard autocomplete labels will be filled.',
    buttons: ['Fill contact', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }) === 0
  if (!confirmed || !stillOnOrigin(tab, origin)) return
  try {
    const contact = await useAutofillVault(vault => vault.resolveContact(id))
    if (contact === undefined || !stillOnOrigin(tab, origin)) return
    await pageControl(tab, 'autofill_contact', {
      expectedOrigin: origin,
      fields: contact.fields,
      ...point,
    })
  } catch (error) {
    if (!isNavigationInterruption(error)) log('saved contact could not be filled')
  }
}

/** Native page menu matching the desktop browser controls. */
async function openPageMenu(tab, params) {
  if (activeTab !== tab || windowClosing) return
  const contents = tab.view.webContents
  const origin = httpOrigin(contents.getURL())
  const point = Number.isFinite(params.x) && Number.isFinite(params.y) ? { x: params.x, y: params.y } : {}
  let logins = []
  let contacts = []
  if (origin !== undefined && autofillVault !== undefined) {
    try {
      [logins, contacts] = await Promise.all([
        useAutofillVault(vault => vault.listLogins()),
        useAutofillVault(vault => vault.listContacts()),
      ])
    } catch {
      logins = []
      contacts = []
    }
  }
  if (activeTab !== tab || contents.isDestroyed()
    || (origin !== undefined && httpOrigin(contents.getURL()) !== origin)) return

  const matchingLogins = logins.filter(login => login.origin === origin)
  const unavailableLabel = autofillVault === undefined ? 'Secure autofill storage unavailable' : undefined
  const history = contents.navigationHistory
  const annotationEnabled = typeof embedded?.onAnnotation === 'function'
  Menu.buildFromTemplate([
    {
      label: 'Autofill login',
      enabled: origin !== undefined,
      submenu: matchingLogins.length > 0
        ? matchingLogins.map(login => ({
            label: autofillMenuLabel(login.username, 'Saved login'),
            click: () => { void fillSavedLogin(tab, origin, login.id, point) },
          }))
        : [{ label: unavailableLabel ?? 'No saved login for this site', enabled: false }],
    },
    {
      label: 'Autofill contact',
      enabled: origin !== undefined,
      submenu: contacts.length > 0
        ? contacts.map(contact => ({
            label: autofillMenuLabel(contact.label, 'Saved contact'),
            click: () => { void fillSavedContact(tab, origin, contact.id, point) },
          }))
        : [{ label: unavailableLabel ?? 'No saved contacts', enabled: false }],
    },
    { type: 'separator' },
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
    { label: 'Back', enabled: history.canGoBack(), click: () => { moveInHistory(contents, -1) } },
    { label: 'Forward', enabled: history.canGoForward(), click: () => { moveInHistory(contents, 1) } },
    { label: 'Reload', click: () => { reloadAllowed(contents) } },
    { type: 'separator' },
    {
      label: 'Inspect',
      click: () => {
        contents.openDevTools({ mode: 'detach' })
        contents.inspectElement(params.x, params.y)
      },
    },
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

const FILE_INPUT_MARK = 'data-hydra-host-file-input'

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
  const expectedOrigin = canonicalOrigin(args.expectedOrigin)
  if (args.tabId !== tab.id || expectedOrigin === undefined || expectedOrigin !== args.expectedOrigin) {
    return { success: false, message: '❌ File upload requires a Host-bound tab and HTTP(S) origin.' }
  }
  const origin = httpOrigin(contents.getURL())
  if (origin !== expectedOrigin) {
    return { success: false, message: '❌ File upload target changed before approval could be applied.' }
  }
  const devtools = contents.debugger
  let attached = false
  let markToken

  try {
    attached = ensureTabDebugger(tab, false)
    const marked = await pageControl(tab, 'mark_file_input', { index: args.index })
    if (typeof marked?.token !== 'string' || !/^[0-9a-f-]{36}$/iu.test(marked.token)) {
      throw new Error('the indexed element is not an HTML file input')
    }
    markToken = marked.token
    const document = await devtools.sendCommand('DOM.getDocument', { depth: 0 })
    const located = await devtools.sendCommand('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: `input[${FILE_INPUT_MARK}="${marked.token}"]`,
    })
    if (!Number.isInteger(located?.nodeId) || located.nodeId === 0) {
      throw new Error('the indexed element is not an HTML file input')
    }
    const hit = await devtools.sendCommand('DOM.describeNode', { nodeId: located.nodeId })
    if (!isFileInputNode(hit?.node)) throw new Error('the indexed element is not an HTML file input')
    if (!tabs.has(tab.id) || contents.isDestroyed() || httpOrigin(contents.getURL()) !== expectedOrigin) {
      throw new Error('the target page origin changed before the file could be selected')
    }
    await devtools.sendCommand('DOM.setFileInputFiles', {
      files: [args.filePath],
      nodeId: located.nodeId,
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
    if (markToken !== undefined) {
      await pageControl(tab, 'unmark_file_input', { token: markToken }).catch(() => {
        // The document may already have navigated away from the marked input.
      })
    }
    if (attached && !tab.cdp.persistent) detachTabDebugger(tab, true)
  }
}

function validatedCdpCommand(args) {
  if (typeof args.method !== 'string' || args.method.length > 128 || !CDP_METHOD.test(args.method)) {
    throw new Error('CDP method must use Domain.command syntax')
  }
  const domain = args.method.slice(0, args.method.indexOf('.'))
  if (CROSS_TARGET_CDP_DOMAINS.has(domain)) {
    throw new Error(`CDP domain ${domain} is unavailable outside the controlled tab`)
  }
  if (typeof args.params !== 'object' || args.params === null || Array.isArray(args.params)) {
    throw new Error('CDP params must be a JSON object')
  }
  const encoded = JSON.stringify(args.params)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CDP_PARAMS_BYTES) {
    throw new Error(`CDP params exceed ${MAX_CDP_PARAMS_BYTES} bytes`)
  }
  return { method: args.method, params: args.params }
}

/** Send one host-approved CDP command without allowing a target breakout. */
async function sendCdpCommand(tab, args) {
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess) {
    throw new Error('full browser CDP access is disabled')
  }
  const command = validatedCdpCommand(args)
  const contents = tab.view.webContents
  const expectedOrigin = canonicalOrigin(args.expectedOrigin)
  if (args.tabId !== tab.id || expectedOrigin === undefined || expectedOrigin !== args.expectedOrigin) {
    throw new Error('CDP command requires a Host-bound tab and HTTP(S) origin')
  }
  if (httpOrigin(contents.getURL()) !== expectedOrigin) {
    throw new Error('CDP target changed before approval could be applied')
  }
  const devtools = contents.debugger
  ensureTabDebugger(tab, true)
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess
    || !tabs.has(tab.id) || contents.isDestroyed() || httpOrigin(contents.getURL()) !== expectedOrigin) {
    throw new Error('CDP target changed before the command could run')
  }
  const result = await devtools.sendCommand(command.method, command.params)
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('CDP returned a non-object result')
  }
  const encoded = JSON.stringify(result)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CDP_RESULT_BYTES) {
    throw new Error(`CDP result exceeds ${MAX_CDP_RESULT_BYTES} bytes`)
  }
  return result
}

/** Read one bounded page from the retained event stream of an approved tab. */
function readCdpEvents(tab, args) {
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess) {
    throw new Error('full browser CDP access is disabled')
  }
  const afterSequence = args.afterSequence ?? 0
  const limit = args.limit ?? MAX_CDP_EVENT_RESULTS
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new Error('CDP event cursor must be a non-negative integer')
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CDP_EVENT_RESULTS) {
    throw new Error(`CDP event limit must be from 1 to ${MAX_CDP_EVENT_RESULTS}`)
  }
  if (args.method !== undefined && (typeof args.method !== 'string'
    || args.method.length > 128 || !CDP_METHOD.test(args.method))) {
    throw new Error('CDP event method filter must use Domain.event syntax')
  }
  const contents = tab.view.webContents
  const expectedOrigin = canonicalOrigin(args.expectedOrigin)
  if (args.tabId !== tab.id || expectedOrigin === undefined || expectedOrigin !== args.expectedOrigin) {
    throw new Error('CDP event read requires a Host-bound tab and HTTP(S) origin')
  }
  if (httpOrigin(contents.getURL()) !== expectedOrigin) {
    throw new Error('CDP target changed before approval could be applied')
  }
  ensureTabDebugger(tab, true)
  if (!nativeSettings.fullCdpAccessAllowed || !nativeSettings.fullCdpAccess
    || !tabs.has(tab.id) || contents.isDestroyed() || httpOrigin(contents.getURL()) !== expectedOrigin) {
    throw new Error('CDP target changed before events could be read')
  }

  const events = []
  let nextSequence = afterSequence
  let scannedAll = true
  for (const retained of tab.cdp.events) {
    if (retained.sequence <= afterSequence) continue
    if (args.method !== undefined && retained.method !== args.method) {
      nextSequence = retained.sequence
      continue
    }
    const event = {
      sequence: retained.sequence,
      method: retained.method,
      params: retained.params,
      receivedAt: retained.receivedAt,
    }
    const page = { events: [...events, event], nextSequence: retained.sequence }
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_CDP_RESULT_BYTES) {
      scannedAll = false
      break
    }
    events.push(event)
    nextSequence = retained.sequence
    if (events.length === limit) {
      scannedAll = false
      break
    }
  }
  if (scannedAll) nextSequence = Math.max(nextSequence, tab.cdp.nextSequence - 1)
  return { events, nextSequence }
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
  noteAgentBrowser(method, args ?? {})
  if (method === 'autofill_login' || method === 'autofill_contact') {
    throw new Error(`unknown browser method: ${method}`)
  }
  if (method === 'autofill_status') return autofillStatus()
  if (method === 'autofill_list_logins') {
    return await useAutofillVault(vault => vault.listLogins())
  }
  if (method === 'autofill_save_login') {
    return await useAutofillVault(vault => vault.saveLogin(args))
  }
  if (method === 'autofill_remove_login') {
    return await useAutofillVault(vault => vault.removeLogin(args.id))
  }
  if (method === 'autofill_list_contacts') {
    return await useAutofillVault(vault => vault.listContacts())
  }
  if (method === 'autofill_get_contact') {
    return await useAutofillVault(async vault => await vault.resolveContact(args.id) ?? null)
  }
  if (method === 'autofill_save_contact') {
    return await useAutofillVault(vault => vault.saveContact(args))
  }
  if (method === 'autofill_remove_contact') {
    return await useAutofillVault(vault => vault.removeContact(args.id))
  }
  if (method === 'configure_browser') {
    return { success: true, ...configureBrowserSettings(args) }
  }
  if (method === 'clear_browser_data') {
    const scope = clearDataScope(args)
    if (scope === 'all') for (const tab of tabs.values()) detachTabDebugger(tab, true)
    if (scope === 'all' || scope === 'site-data') await Promise.all([...sessionCookieWrites])
    await profileStoreWrite
    if (scope === 'all') await browserSession.clearData()
    else if (scope === 'site-data') await browserSession.clearData({ dataTypes: SITE_DATA_TYPES })
    else if (scope === 'cache') await browserSession.clearData({ dataTypes: ['cache'] })
    else if (scope === 'downloads') await browserSession.clearData({ dataTypes: ['downloads'] })
    if (scope === 'all' || scope === 'history') {
      for (const tab of tabs.values()) tab.view.webContents.navigationHistory.clear()
      profileStore.history = []
    }
    if (scope === 'all' || scope === 'downloads') profileStore.downloads = []
    if (scope === 'all' || scope === 'history' || scope === 'downloads') await persistProfileStore()
    return { success: true, scope }
  }
  if (method === 'browser_history') return profileStore.history.map(entry => ({ ...entry }))
  if (method === 'search_browser_history') return searchHistory(args)
  if (method === 'remove_browser_history') {
    if (typeof args.id !== 'string') throw new Error('history id must be a string')
    profileStore.history = profileStore.history.filter(entry => entry.id !== args.id)
    await persistProfileStore()
    return { success: true }
  }
  if (method === 'browser_downloads') return profileStore.downloads.map(entry => ({ ...entry }))
  if (method === 'remove_browser_download') {
    if (typeof args.id !== 'string') throw new Error('download id must be a string')
    profileStore.downloads = profileStore.downloads.filter(entry => entry.id !== args.id)
    await persistProfileStore()
    return { success: true }
  }
  if (method === 'browser_sites') return listSites()
  if (method === 'set_browser_site') {
    await setSite(args)
    return { success: true }
  }
  if (method === 'remove_browser_site') {
    removeSite(args)
    await profileStoreWrite
    return { success: true }
  }
  if (method === 'route_user_url') return await routeUserUrl(args.url)
  if (method === 'open_new_tab') {
    if (args.url !== undefined && (!activeTab || !navigationAllowed(activeTab.view.webContents, args.url))) {
      throw new Error(`navigation to ${args.url} was blocked by Browser settings`)
    }
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
    case 'get_upload_target': {
      const origin = httpOrigin(contents.getURL())
      if (origin === undefined) throw new Error('file upload requires a currently observed HTTP(S) page')
      return { origin, tabId: tab.id }
    }

    case 'get_cdp_target': {
      const origin = httpOrigin(contents.getURL())
      if (origin === undefined) throw new Error('CDP requires a currently observed HTTP(S) page')
      return { origin, tabId: tab.id }
    }

    case 'get_browser_state':
      return await readBrowserState(tab, args.waitForReady === true, args.tabId === undefined)

    case 'browser_screenshot': {
      if (Object.hasOwn(args, 'tabId')) throw new Error('browser_screenshot does not accept tabId')
      const url = contents.getURL()
      if (httpOrigin(url) === undefined) {
        throw new Error('browser screenshot requires the selected tab to show an HTTP(S) page')
      }
      const screenshot = await boundedPng(contents)
      if (screenshot === undefined) {
        throw new Error(`browser screenshot is empty or exceeds the ${MAX_SCREENSHOT_BYTES}-byte PNG limit`)
      }
      if (activeTab !== tab || contents.isDestroyed() || contents.getURL() !== url) {
        throw new Error('selected browser tab changed while its screenshot was captured')
      }
      return {
        mediaType: 'image/png',
        ...screenshot,
        tabId: tab.id,
        url,
        title: contents.getTitle(),
        capturedAt: new Date().toISOString(),
      }
    }

    case 'navigate':
      // Resolves on did-finish-load, so a caller that awaits this is talking to
      // the preload of the page it asked for, not the one it is leaving.
      await loadAllowedUrl(contents, args.url)
      return { success: true, message: `Navigated to ${contents.getURL()}` }

    case 'back': {
      const history = contents.navigationHistory
      const loaded = once(contents, 'did-finish-load')
      if (history.canGoBack()) {
        const targetUrl = historyDestination(contents, -1)
        if (targetUrl === undefined || siteNavigationBlocked(targetUrl)) {
          throw new Error(`navigation to ${targetUrl ?? 'the earlier page'} was blocked by Browser settings`)
        }
        history.goToIndex(history.getActiveIndex() - 1)
      } else {
        const moved = await pageControl(tab, 'history_go', { delta: -1 })
        if (moved?.success !== true) {
          return { success: false, message: moved?.message ?? 'No earlier page in this view.' }
        }
      }
      await loaded
      return { success: true, message: `Went back to ${contents.getURL()}` }
    }

    case 'forward': {
      const history = contents.navigationHistory
      const loaded = once(contents, 'did-finish-load')
      if (history.canGoForward()) {
        const targetUrl = historyDestination(contents, 1)
        if (targetUrl === undefined || siteNavigationBlocked(targetUrl)) {
          throw new Error(`navigation to ${targetUrl ?? 'the later page'} was blocked by Browser settings`)
        }
        history.goToIndex(history.getActiveIndex() + 1)
      } else {
        const moved = await pageControl(tab, 'history_go', { delta: 1 })
        if (moved?.success !== true) {
          return { success: false, message: moved?.message ?? 'No later page in this view.' }
        }
      }
      await loaded
      return { success: true, message: `Went forward to ${contents.getURL()}` }
    }

    case 'reload': {
      if (siteNavigationBlocked(contents.getURL())) {
        throw new Error(`navigation to ${contents.getURL()} was blocked by Browser settings`)
      }
      const loaded = once(contents, 'did-finish-load')
      contents.reload()
      await loaded
      return { success: true, message: `Reloaded ${contents.getURL()}` }
    }

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

    case 'cdp_command':
      return await sendCdpCommand(tab, args)

    case 'cdp_read_events':
      return readCdpEvents(tab, args)

    default:
      try {
        return await pageControl(tab, method, args)
      } catch (error) {
        if (isNavigationInterruption(error)
          && ['click_element', 'input_text', 'select_option', 'fill_fields'].includes(method)) {
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
    : session.fromPartition('persist:hydra-controlled-browser')
  await Promise.all([loadProfileStore(), initializeAutofillVault()])
  nativeTheme.on('updated', updateChrome)
  configureBrowserSettings(nativeSettings)
  browserSession.on('will-download', beginDownload)
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    contents !== null && permission === 'media'
      ? mediaPermissionAllowed(contents, requestingOrigin, false)
      : false)
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = details.requestingUrl ?? contents.getURL()
    callback(permission === 'media' && mediaPermissionAllowed(contents, origin, true))
  })
  browserSession.setDevicePermissionHandler(() => false)
  browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
  if (PERSIST_SESSION_COOKIES) {
    browserSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (!removed) persistSessionCookie(cookie)
    })
  }
  window = embedded?.window ?? new BrowserWindow({
    width: config.width ?? 1280,
    height: config.height ?? 900,
    show: config.show ?? true,
    title: 'Hydra harness — controlled browser',
    icon: join(__dirname, 'hydra.png'),
  })
  window.once('close', () => {
    windowClosing = true
    for (const tab of tabs.values()) detachTabDebugger(tab, true)
  })

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
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        session: browserSession,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    const tab = {
      id: nextTabId++,
      cdp: { owned: false, persistent: false, nextSequence: 1, events: [], bytes: 0 },
      view,
      contents: view.webContents,
      favicon: '',
    }
    tabs.set(tab.id, tab)
    window.contentView.addChildView(tab.view)
    tab.view.setVisible(false)

    const { contents } = tab
    contents.debugger.on('message', (_event, method, params) => { recordCdpEvent(tab, method, params) })
    contents.debugger.on('detach', () => {
      tab.cdp.owned = false
      tab.cdp.persistent = false
      tab.cdp.events = []
      tab.cdp.bytes = 0
    })
    contents.on('context-menu', (event, params) => {
      event.preventDefault()
      void openPageMenu(tab, params).catch(() => { log('page context menu could not be opened') })
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (!navigationAllowed(contents, url)) return { action: 'deny' }
      const opened = createTab?.()
      if (!opened || !selectTab) return { action: 'deny' }
      selectTab(opened)
      void opened.view.webContents.loadURL(url).catch(error => log('new-tab navigation failed:', error))
      return { action: 'deny' }
    })
    const enforceNavigation = (event, url) => {
      if (!navigationAllowed(contents, url)) event.preventDefault()
    }
    contents.on('will-navigate', enforceNavigation)
    contents.on('will-redirect', enforceNavigation)
    // Both ends of a document's life invalidate only the preload holding that
    // tab's indices; a background tab cannot cancel an active tab's action.
    contents.on('did-start-navigation', event => {
      if (!event.isMainFrame) return
      detachTabDebugger(tab, true)
      cancelAnnotation(tab)
      abortPageCalls(tab, 'page navigated away before the action completed')
      abortPageAgentLlmCalls(tab, 'page navigated away before PageAgent received a model response')
    })
    contents.on('render-process-gone', (_event, details) => {
      detachTabDebugger(tab, true)
      abortPageCalls(tab, `renderer gone: ${details.reason}`)
      abortPageAgentLlmCalls(tab, `renderer gone: ${details.reason}`)
    })
    contents.on('destroyed', () => {
      detachTabDebugger(tab, true)
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
    contents.on('did-finish-load', () => { recordHistory(contents) })
    contents.on('did-navigate-in-page', () => { recordHistory(contents) })
    contents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = typeof favicons?.[0] === 'string' ? favicons[0] : ''
      updateChrome()
    })
    for (const event of [
      'did-finish-load', 'did-navigate', 'did-navigate-in-page', 'page-title-updated',
      'did-start-loading', 'did-stop-loading',
    ]) {
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
    detachTabDebugger(tab, true)
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
      await loadAllowedUrl(initialTab.view.webContents, HOME_URL)
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
      void loadAllowedUrl(tab.view.webContents, resolveOmnibox(value.trim()))
        .catch(error => log('omnibox navigation failed:', error))
    })
    ipcMain.on('browser-chrome:back', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      moveInHistory(activeTab.view.webContents, -1)
    })
    ipcMain.on('browser-chrome:forward', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      moveInHistory(activeTab.view.webContents, 1)
    })
    ipcMain.on('browser-chrome:reload', event => {
      if (event.sender !== chrome.webContents || !activeTab) return
      reloadAllowed(activeTab.view.webContents)
    })
    ipcMain.on('browser-chrome:annotate', event => {
      if (event.sender !== chrome.webContents) return
      if (!activeTab || typeof embedded?.onAnnotation !== 'function') {
        chrome.webContents.send('browser-chrome:annotation-ended')
        return
      }
      if (toolbarAnnotation !== undefined) return
      const pending = { tab: activeTab }
      toolbarAnnotation = pending
      void publishAnnotation(pending.tab, 'annotate_element', {}).finally(() => {
        if (toolbarAnnotation !== pending) return
        toolbarAnnotation = undefined
        if (!chrome.webContents.isDestroyed()) chrome.webContents.send('browser-chrome:annotation-ended')
      })
    })
    ipcMain.on('browser-chrome:cancel-annotation', event => {
      if (event.sender === chrome.webContents && toolbarAnnotation !== undefined) {
        cancelAnnotation(toolbarAnnotation.tab)
      }
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
      else pending.reject(new Error(args.error ?? 'Hydra could not complete the PageAgent model request'))
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
          detachTabDebugger(tab, true)
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
        await profileStoreWrite
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
      void Promise.all([flushSessionCookies(), profileStoreWrite])
        .catch(error => log('profile flush failed:', error)).finally(() => app.quit())
    })

    // The parent waits for this before sending anything; Electron's own startup
    // noise on stdout arrives before it and is skipped as unparseable.
    send({ event: 'ready' })
  }
})

// Closing the window by hand is a shutdown too: the parent sees the child exit
// and knows to spawn a fresh one next time.
if (embedded === undefined) app.on('window-all-closed', () => app.quit())
