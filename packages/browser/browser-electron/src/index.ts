/**
 * Owner-scoped embedded browser. One agent gets one Electron window, started
 * on its first action and closed with the agent, driven through the upstream
 * PageAgent runtime running in the view's preload.
 * @module @hydra1902/harness-browser-electron
 */

import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@hydra1902/cordis'
import z from '@hydra1902/schemastery'
import type { Agent } from '@hydra1902/harness-agent'
import { resolveHydraHome } from '@hydra1902/harness-home-paths'
import { installSettingsSection, settingsNamespace } from '@hydra1902/harness-settings'
import type { ApprovalRequest } from '@hydra1902/harness-user-approval'
import '@hydra1902/harness-user-questions'
import { launchBrowser } from './child.ts'
import type { BrowserChild, BrowserChildProcess } from './child.ts'
import { executePageAgentLlm } from './page-agent-llm.ts'
import { BrowserError } from './types.ts'
import type {
  ActionResult, BrowserAction, BrowserCdpCommandResult, BrowserCdpEventPage, BrowserHistorySearchEntry,
  BrowserJsonValue, BrowserOutcome, BrowserPageIdentity, BrowserScreenshot, BrowserScreenshotOptions, BrowserState,
} from './types.ts'

export { launchBrowser, resolveElectronPath } from './child.ts'
export type { BrowserChild, BrowserChildProcess, LaunchOptions, PageAgentLlmRequest } from './child.ts'
export { BrowserError } from './types.ts'
export type {
  ActionResult, BrowserAction, BrowserCdpCommandResult, BrowserCdpEvent, BrowserCdpEventPage, BrowserErrorCode,
  BrowserSnapshotOptions, BrowserFillField, BrowserHistorySearchEntry, BrowserJsonValue,
  BrowserOutcome, BrowserPageIdentity, BrowserScreenshot, BrowserScreenshotClip, BrowserScreenshotOptions, BrowserState, BrowserUiChanges,
  BrowserTabState,
} from './types.ts'

/** Durable settings namespace owned by the embedded browser service. */
export const BROWSER_SETTINGS_NAMESPACE = settingsNamespace('browser-electron')

/** Closed user decision used by native Browser permission checks. */
export type BrowserDecision = 'allow' | 'ask' | 'block'

/** Independent global permissions for Browser Use, shared by all agents and websites. */
export interface BrowserPermissions {
  /** Decision before browser navigation, page actions, and reads. */
  browsing: BrowserDecision
  /** Decision before Chromium writes downloaded files. */
  downloads: BrowserDecision
  /** Decision before selecting a local file for a website. */
  uploads: BrowserDecision
}

/** Where a user-opened HTTP(S) URL leaves the desktop application. */
export type BrowserDestination = 'hydra' | 'system'

/** Whether a browser annotation carries a bounded element screenshot. */
export type BrowserAnnotationScreenshots = 'include' | 'ask' | 'never'

/** User-controlled Browser settings consumed by Host and Electron operations. */
export interface BrowserSettings {
  /** Global action permissions; absent values inherit the existing saved policies. */
  browserPermissions: BrowserPermissions | undefined
  /** Whether agents may control the embedded browser. */
  controlEnabled: boolean
  /** Destination for user-opened non-loopback web URLs. */
  webDestination: BrowserDestination
  /** Destination for user-opened loopback HTTP(S) URLs. */
  localDestination: BrowserDestination
  /** Screenshot behavior for browser annotations. */
  annotationScreenshots: BrowserAnnotationScreenshots
  /** Directory used for downloads; empty keeps the system Downloads folder. */
  downloadDirectory: string
  /** Whether every download opens a native save dialog. */
  askWhereToSave: boolean
  /** Default decision before opening a website without a site override. */
  navigationPolicy: BrowserDecision
  /** Default decision before a website download starts. */
  downloadPolicy: BrowserDecision
  /** Decision before an agent selects a local file for upload. */
  uploadPolicy: BrowserDecision
  /** Decision before an agent searches the profile browsing history. */
  historyAccessPolicy: BrowserDecision
  /** User opt-in for raw, tab-scoped Chrome DevTools Protocol commands. */
  fullCdpAccess: boolean
}

/** Tool-call identity and cancellation carried into an interactive Browser decision. */
export type BrowserExecutionContext = Pick<ApprovalRequest, 'callId' | 'signal'>

/** Schema for the small user-facing browser policy section. */
const BrowserSettingsSchema: z<BrowserSettings> = z.object({
  browserPermissions: z.union([z.const(undefined), z.object({
    browsing: z.union(['allow', 'ask', 'block'] as const).default('ask').loose(),
    downloads: z.union(['allow', 'ask', 'block'] as const).default('ask').loose(),
    uploads: z.union(['allow', 'ask', 'block'] as const).default('ask').loose(),
  })]).loose(),
  controlEnabled: z.boolean().default(true),
  webDestination: z.union(['hydra', 'system'] as const).default('hydra'),
  localDestination: z.union(['hydra', 'system'] as const).default('hydra'),
  annotationScreenshots: z.union(['include', 'ask', 'never'] as const).default('include'),
  downloadDirectory: z.string().default(''),
  askWhereToSave: z.boolean().default(false),
  navigationPolicy: z.union(['allow', 'ask', 'block'] as const).default('ask').loose(),
  downloadPolicy: z.union(['allow', 'ask', 'block'] as const).default('ask').loose(),
  uploadPolicy: z.union(['allow', 'ask', 'block'] as const).default('ask').loose(),
  historyAccessPolicy: z.union(['allow', 'ask', 'block'] as const).default('ask'),
  fullCdpAccess: z.boolean().default(false),
})

const DEFAULT_BROWSER_SETTINGS: BrowserSettings = Object.freeze({
  browserPermissions: undefined,
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
})
const DISABLED_BROWSER_SETTINGS: BrowserSettings = Object.freeze({
  ...DEFAULT_BROWSER_SETTINGS,
  controlEnabled: false,
})

declare module '@hydra1902/cordis' {
  interface Context {
    browsers: BrowserSessionService
  }
  interface Events {
    /**
     * The effective Full CDP gate changed after a user setting or deployment
     * policy update; listeners may refresh model-facing CDP tool registration.
     * @mode emit
     * @param enabled - whether the organization ceiling and user opt-in both allow CDP.
     */
    'browser/full-cdp-access'(enabled: boolean): void
  }
}

/** Embedded browser configuration. */
export interface Config {
  /** Chromium profile directory; the default keeps SSO under the harness home. */
  userDataDir?: string
  /** Optional initial HTTP(S) page for each newly created browser window. */
  homeUrl?: string
  /** Promote session cookies into the persistent Chromium cookie store. */
  persistSessionCookies?: boolean
  /** Window width in pixels. */
  width?: number
  /** Window height in pixels. */
  height?: number
  /** Show the window. Headed by default: the user watches what the agent does. */
  show?: boolean
  /** How long one Electron start may take. */
  startupTimeoutMs?: number
  /** How long one action may take. */
  actionTimeoutMs?: number
  /** How long navigation/state reads wait for usable SPA content. */
  readinessTimeoutMs?: number
  /** Allow the experimental isolated-world JavaScript action. */
  experimentalScriptExecution?: boolean
  /** Organization ceiling for the elevated-risk full CDP setting. */
  allowFullCdpAccess?: boolean
  /** Explicit Electron binary; omitted resolves the optional `electron` package. */
  electronPath?: string
  /** Optional composition default for browser permissions; user settings override it. */
  browserPermissions?: BrowserPermissions | undefined
}

/** Config after schemastery's defaults, with the profile path resolved. */
type ResolvedSettings = Omit<Required<Config>, 'homeUrl' | 'electronPath'> & Pick<Config, 'homeUrl' | 'electronPath'>

/** Normalize the optional browser home before an Electron child receives it. */
function homeUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch {}
  throw new Error('browser-electron: homeUrl must be an absolute http(s) URL')
}

const MAX_HISTORY_SEARCH_RESULTS = 20
/** Maximum accepted PNG payload size. */
export const MAX_BROWSER_SCREENSHOT_BYTES = 3_500_000
/** Maximum accepted PNG image edge length. */
export const MAX_BROWSER_SCREENSHOT_EDGE = 2_000
const MAX_BROWSER_SCREENSHOT_BASE64_CHARS = Math.ceil(MAX_BROWSER_SCREENSHOT_BYTES / 3) * 4
const MAX_CDP_PARAMS_BYTES = 64 * 1_024
const MAX_CDP_RESULT_BYTES = 1_024 * 1_024
const MAX_CDP_EVENT_RESULTS = 100
const CDP_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u
const CROSS_TARGET_CDP_DOMAINS = new Set(['Browser', 'SystemInfo', 'Target', 'Tethering'])

/** Validate the transient Electron capture before any consumer can persist it. */
function browserScreenshotOf(value: unknown): BrowserScreenshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('embedded browser returned an invalid screenshot')
  }
  const screenshot = value as Record<string, unknown>
  if (screenshot.mediaType !== 'image/png'
    || typeof screenshot.data !== 'string'
    || screenshot.data.length > MAX_BROWSER_SCREENSHOT_BASE64_CHARS
    || !Number.isSafeInteger(screenshot.bytes) || (screenshot.bytes as number) < 1
    || !Number.isSafeInteger(screenshot.width) || (screenshot.width as number) < 1
    || !Number.isSafeInteger(screenshot.height) || (screenshot.height as number) < 1
    || !Number.isSafeInteger(screenshot.tabId) || (screenshot.tabId as number) < 1
    || typeof screenshot.url !== 'string' || screenshot.url.length > 2_048
    || typeof screenshot.title !== 'string' || screenshot.title.length > 512
    || !['viewport', 'full-page', 'clip'].includes(screenshot.mode as string)
    || typeof screenshot.capturedAt !== 'string' || screenshot.capturedAt.length > 64) {
    throw new Error('embedded browser returned an invalid screenshot')
  }
  if (screenshot.clip !== undefined) {
    const clip = screenshot.clip
    if (typeof clip !== 'object' || clip === null || Array.isArray(clip)
      || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger((clip as Record<string, unknown>)[key]))) {
      throw new Error('embedded browser returned an invalid screenshot clip')
    }
  }
  try {
    const url = new URL(screenshot.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
  } catch {
    throw new Error('embedded browser returned a screenshot for a non-HTTP(S) page')
  }
  const png = Buffer.from(screenshot.data, 'base64')
  if (png.toString('base64') !== screenshot.data) {
    throw new Error('embedded browser returned a screenshot with non-canonical base64')
  }
  if (png.length !== screenshot.bytes
    || png.length < 24
    || !png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || png.readUInt32BE(8) !== 13
    || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('embedded browser returned invalid PNG screenshot bytes')
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width !== screenshot.width || height !== screenshot.height) {
    throw new Error('embedded browser returned mismatched screenshot dimensions')
  }
  if (png.length > MAX_BROWSER_SCREENSHOT_BYTES
    || width > MAX_BROWSER_SCREENSHOT_EDGE || height > MAX_BROWSER_SCREENSHOT_EDGE) {
    throw new Error('embedded browser returned a screenshot outside the configured bounds')
  }
  if (Number.isNaN(Date.parse(screenshot.capturedAt))) {
    throw new Error('embedded browser returned an invalid screenshot timestamp')
  }
  return screenshot as unknown as BrowserScreenshot
}

function historySearchResults(value: unknown): BrowserHistorySearchEntry[] {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_SEARCH_RESULTS) {
    throw new Error('embedded browser returned an invalid history search result')
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('embedded browser returned an invalid history entry')
    }
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.url !== 'string' || candidate.url.length > 2_048
      || typeof candidate.title !== 'string' || candidate.title.length > 512
      || typeof candidate.visitedAt !== 'string' || candidate.visitedAt.length > 64) {
      throw new Error('embedded browser returned an invalid history entry')
    }
    try {
      const url = new URL(candidate.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    } catch {
      throw new Error('embedded browser returned an invalid history URL')
    }
    return { url: candidate.url, title: candidate.title, visitedAt: candidate.visitedAt }
  })
}

function browserPageIdentityOf(value: unknown): BrowserPageIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('embedded browser returned an invalid page identity')
  }
  const identity = value as Record<string, unknown>
  if (typeof identity.url !== 'string' || identity.url.length === 0 || identity.url.length > 2_048
    || typeof identity.title !== 'string' || identity.title.length > 512
    || !Number.isSafeInteger(identity.tabId) || (identity.tabId as number) < 1
    || !Number.isSafeInteger(identity.activeTabId) || (identity.activeTabId as number) < 1
    || typeof identity.settled !== 'boolean') {
    throw new Error('embedded browser returned an invalid page identity')
  }
  if (!URL.canParse(identity.url)) throw new Error('embedded browser returned an invalid page URL')
  return identity as unknown as BrowserPageIdentity
}

function boundedCdpParams(method: string, params: unknown): Record<string, unknown> {
  if (method.length > 128 || !CDP_METHOD.test(method)) throw new Error('CDP method must use Domain.command syntax')
  if (CROSS_TARGET_CDP_DOMAINS.has(method.slice(0, method.indexOf('.')))) {
    throw new Error(`CDP domain ${method.slice(0, method.indexOf('.'))} is unavailable outside the controlled tab`)
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('CDP params must be a JSON object')
  }
  const serialized = JSON.stringify(params)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CDP_PARAMS_BYTES) {
    throw new Error(`CDP params exceed ${MAX_CDP_PARAMS_BYTES} bytes`)
  }
  return params as Record<string, unknown>
}

function boundedCdpResult(method: string, value: unknown): BrowserCdpCommandResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('embedded browser returned an invalid CDP result')
  }
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CDP_RESULT_BYTES) {
    throw new Error(`CDP result exceeds ${MAX_CDP_RESULT_BYTES} bytes`)
  }
  return { method, result: value as Record<string, BrowserJsonValue> }
}

function boundedCdpEventPage(value: unknown): BrowserCdpEventPage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('embedded browser returned an invalid CDP event page')
  }
  const page = value as Record<string, unknown>
  if (!Number.isSafeInteger(page.nextSequence) || (page.nextSequence as number) < 0
    || !Array.isArray(page.events) || page.events.length > MAX_CDP_EVENT_RESULTS) {
    throw new Error('embedded browser returned an invalid CDP event page')
  }
  const encoded = JSON.stringify(page)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CDP_RESULT_BYTES) {
    throw new Error(`CDP event page exceeds ${MAX_CDP_RESULT_BYTES} bytes`)
  }
  for (const event of page.events) {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new Error('embedded browser returned an invalid CDP event')
    }
    const candidate = event as Record<string, unknown>
    if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 1
      || typeof candidate.method !== 'string' || !CDP_METHOD.test(candidate.method)
      || typeof candidate.receivedAt !== 'string' || candidate.receivedAt.length > 64
      || typeof candidate.params !== 'object' || candidate.params === null || Array.isArray(candidate.params)) {
      throw new Error('embedded browser returned an invalid CDP event')
    }
  }
  return page as unknown as BrowserCdpEventPage
}

/** Resolve and validate the file before the Uploads permission decision. */
async function prepareAction(action: BrowserAction): Promise<BrowserAction> {
  if (action.method === 'drop') {
    const filePaths: string[] = []
    for (const filePath of action.filePaths) {
      const file = await prepareAction({ method: 'upload_file', index: action.index, filePath })
      /* v8 ignore next -- Preparing an upload preserves its method. */
      if (file.method === 'upload_file') filePaths.push(file.filePath)
    }
    return { ...action, filePaths }
  }
  if (action.method !== 'upload_file') return action
  if (!isAbsolute(action.filePath)) throw new Error('upload file path must be absolute')
  try {
    const filePath = await realpath(action.filePath)
    if (!(await stat(filePath)).isFile()) throw new Error('path is not a regular file')
    await access(filePath, constants.R_OK)
    return { ...action, filePath }
  } catch (cause) {
    throw new Error(`upload file must be an existing readable regular file: ${action.filePath}`, { cause })
  }
}

const READY = Promise.resolve()

interface OwnerQueue {
  barrier: Promise<void>
  readonly tabs: Map<number, Promise<void>>
}

/** Explicit page targets may overlap; implicit and lifecycle actions are barriers. */
function queueTabId(action: BrowserAction): number | undefined {
  if (action.method === 'open_new_tab' || action.method === 'switch_to_tab' || action.method === 'close_tab') {
    return undefined
  }
  return action.tabId
}

/** Tab whose state must follow an action; close/open resolve to the selected tab. */
function stateTabId(action: BrowserAction): number | undefined {
  if (action.method === 'open_new_tab' || action.method === 'close_tab') return undefined
  return action.tabId
}

/** Settings enforced inside the Electron-owned profile and navigation paths. */
function nativeSettings(settings: BrowserSettings, fullCdpAccessAllowed: boolean): Pick<
  BrowserSettings,
  'webDestination' | 'localDestination' | 'annotationScreenshots'
  | 'downloadDirectory' | 'askWhereToSave' | 'navigationPolicy' | 'downloadPolicy' | 'fullCdpAccess'
> & { fullCdpAccessAllowed: boolean } {
  return {
    webDestination: settings.webDestination,
    localDestination: settings.localDestination,
    annotationScreenshots: settings.annotationScreenshots,
    downloadDirectory: settings.downloadDirectory,
    askWhereToSave: settings.askWhereToSave,
    navigationPolicy: settings.browserPermissions?.browsing ?? settings.navigationPolicy,
    downloadPolicy: settings.browserPermissions?.downloads ?? settings.downloadPolicy,
    fullCdpAccess: settings.fullCdpAccess,
    fullCdpAccessAllowed,
  }
}

/** One Electron window per agent, started lazily and closed with its owner. */
export class BrowserSessionService extends Service {
  static Config: z<Config> = z.object({
    userDataDir: z.string(),
    homeUrl: z.string(),
    persistSessionCookies: z.boolean().default(false),
    width: z.number().step(1).min(1).default(1280),
    height: z.number().step(1).min(1).default(900),
    show: z.boolean().default(true),
    startupTimeoutMs: z.number().step(1).min(1).default(60_000),
    actionTimeoutMs: z.number().step(1).min(1).default(60_000),
    readinessTimeoutMs: z.number().step(1).min(1).default(45_000),
    experimentalScriptExecution: z.boolean().default(false),
    allowFullCdpAccess: z.boolean().default(true),
    electronPath: z.string(),
    browserPermissions: z.union([z.const(undefined), z.object({
      browsing: z.union(['allow', 'ask', 'block'] as const).default('ask'),
      downloads: z.union(['allow', 'ask', 'block'] as const).default('ask'),
      uploads: z.union(['allow', 'ask', 'block'] as const).default('ask'),
    }).loose()]).loose(),
  })

  private readonly sessions = new Map<Agent, BrowserChild>()
  private readonly browsingApprovals = new WeakMap<Agent, object>()
  private readonly launches = new Map<Agent, { ready: Promise<BrowserChild>; controller: AbortController }>()
  private readonly queues = new WeakMap<Agent, OwnerQueue>()
  private readonly ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  private readonly settings: ResolvedSettings
  /* v8 ignore start -- The constructor installs the settings source before publishing this service. */
  private browserSettings: () => BrowserSettings = () => DEFAULT_BROWSER_SETTINGS
  /* v8 ignore stop */
  private lastFullCdpAccess = false
  private disposing = false

  /** Test seam standing in for the real Electron spawn. */
  spawnChild?: (command: string, args: string[]) => BrowserChildProcess

  /** Whether this host explicitly enabled the experimental JavaScript action. */
  get experimentalScriptExecution(): boolean {
    return this.settings.experimentalScriptExecution
  }

  /** Whether organization policy and the user's elevated-risk opt-in both allow CDP. */
  get fullCdpAccess(): boolean {
    return this.settings.allowFullCdpAccess && this.browserSettings().fullCdpAccess
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'browsers')
    // Schemastery filled every default before construction, so only the
    // profile path is resolved here — deliberately per boot, because its
    // default reads the harness home rather than a constant.
    const initialUrl = homeUrl(config.homeUrl)
    this.settings = {
      ...config as Omit<ResolvedSettings, 'userDataDir'>,
      userDataDir: config.userDataDir ?? join(resolveHydraHome(), 'browser-profile'),
      ...initialUrl === undefined ? {} : { homeUrl: initialUrl },
    }
    const settingsEntry: BrowserSettings = config.browserPermissions === undefined
      ? DEFAULT_BROWSER_SETTINGS
      : { ...DEFAULT_BROWSER_SETTINGS, browserPermissions: config.browserPermissions }
    /* v8 ignore start -- installSettingsSection replaces this source synchronously before any caller can read it. */
    this.browserSettings = () => settingsEntry
    /* v8 ignore stop */
    installSettingsSection(ctx, BROWSER_SETTINGS_NAMESPACE, BrowserSettingsSchema, settingsEntry, {
      validate: (value) => {
        if (value.fullCdpAccess && !this.settings.allowFullCdpAccess) {
          throw new Error('browser-electron: organization policy disables full CDP access')
        }
      },
      setSource: (source) => {
        this.browserSettings = source() === settingsEntry ? () => DISABLED_BROWSER_SETTINGS : source
      },
      onChange: () => {
        if (!this.browserSettings().controlEnabled || this.permissions().browsing !== 'allow') this.stopPageAgents()
        this.configureChildren()
        const fullCdpAccess = this.fullCdpAccess
        if (fullCdpAccess !== this.lastFullCdpAccess) {
          this.lastFullCdpAccess = fullCdpAccess
          this.ctx.emit('browser/full-cdp-access', fullCdpAccess)
        }
      },
    })
    ctx.effect(() => () => this.disposeAll(), 'browser teardown')
  }

  /**
   * Do one thing to an owner's page and report the page afterwards.
   *
   * A captured snapshot refreshes numeric element indexes. With captureState
   * false, the trailing read contains only page identity, tabs, loading, and
   * dialogs; callers must observe the page before reusing numeric indexes.
   * Explicit targets are ordered per tab; implicit and lifecycle actions are barriers.
   * @param owner - agent whose window this is; its first call starts one.
   * @param action - what to do, in page-agent's own vocabulary.
   * @param execution - tool-call identity, cancellation, and optional captureState (default true).
   * @returns the action's report, omitted for a plain state read, plus the state.
   */
  async perform(
    owner: Agent,
    action: BrowserAction,
    execution: BrowserExecutionContext & { captureState?: boolean } = {},
  ): Promise<BrowserOutcome> {
    return this.serialized(owner, queueTabId(action), async () => {
      execution.signal?.throwIfAborted()
      if (this.disposing) throw new BrowserError('the embedded browser is shutting down', 'BROWSER_DISPOSING')
      if (!this.browserSettings().controlEnabled) {
        throw new BrowserError('embedded browser control is disabled in settings', 'BROWSER_DISABLED')
      }
      const uploads = action.method === 'upload_file' || (action.method === 'drop' && action.filePaths.length > 0)
      if (uploads) this.checkPermission('uploads')
      const browsingApproval = this.permissions().browsing === 'ask'
      if (!uploads && action.method !== 'page_agent_stop') {
        await this.approveBrowserPermission(owner, 'browsing', action.method,
          'url' in action ? action.url : undefined, execution)
      }
      const prepared = await prepareAction(action)
      if ((prepared.method === 'execute_javascript' || prepared.method === 'execute_javascript_page')
        && !this.settings.experimentalScriptExecution) {
        throw new Error('experimental browser JavaScript is disabled by the host')
      }
      const child = await this.session(owner, execution.signal)
      const { method, ...args } = prepared
      if ((method === 'navigate' || method === 'open_new_tab') && browsingApproval) {
        Object.assign(args, { navigationApproved: true })
      }
      if (prepared.method === 'upload_file' || (prepared.method === 'drop' && prepared.filePaths.length > 0)) {
        const target = await child.call('get_upload_target', {
          ...prepared.tabId === undefined ? {} : { tabId: prepared.tabId },
        }) as { origin?: unknown; tabId?: unknown }
        if (typeof target.origin !== 'string' || !Number.isSafeInteger(target.tabId)) {
          throw new BrowserError('browser upload target is unavailable', 'BROWSER_POLICY_DENIED')
        }
        for (const filePath of prepared.method === 'upload_file' ? [prepared.filePath] : prepared.filePaths) {
          await this.approveUpload(owner, filePath, {
            origin: target.origin,
            tabId: target.tabId as number,
            index: prepared.index,
          }, execution)
        }
        execution.signal?.throwIfAborted()
        Object.assign(args, { expectedOrigin: target.origin, tabId: target.tabId })
      }
      if (method !== 'page_agent_stop') this.checkPermission(uploads ? 'uploads' : 'browsing')
      const result = method === 'get_browser_state'
        ? undefined
        : await child.call(method, args, execution.signal) as ActionResult
      const waitForReady = prepared.method === 'get_browser_state'
        || prepared.method === 'navigate'
        || prepared.method === 'back'
        || prepared.method === 'forward'
        || prepared.method === 'click_element'
        || prepared.method === 'click_at'
        || prepared.method === 'fill_fields'
        || prepared.method === 'find_element'
        || prepared.method === 'press'
        || prepared.method === 'wait'
        || prepared.method === 'open_new_tab'
        || prepared.method === 'switch_to_tab'
        || prepared.method === 'close_tab'
        || prepared.method === 'select_text'
      const tabId = stateTabId(prepared)
      const state = await child.call('get_browser_state', {
        ...execution.captureState === false ? { metadataOnly: true } : {},
        ...prepared.method === 'get_browser_state' && prepared.snapshot !== undefined ? { snapshot: prepared.snapshot } : {},
        waitForReady,
        ...tabId === undefined ? {} : { tabId },
      }, execution.signal) as BrowserState
      return result === undefined ? { state } : { action: result, state }
    })
  }

  /**
   * Read one live tab's URL, title, and selection without refreshing its page state.
   * Background reads without a call id fail closed when Browsing approval is set to `ask`.
   * @param owner - agent whose open browser owns the tab.
   * @param execution - tool-call identity and cancellation for the browsing approval.
   * @param tabId - optional positive controlled-tab id; omission uses the selected tab.
   * @returns live page metadata, or `undefined` when the owner has no open browser.
   */
  async currentPage(
    owner: Agent,
    execution: BrowserExecutionContext = {},
    tabId?: number,
  ): Promise<BrowserPageIdentity | undefined> {
    if (tabId !== undefined && (!Number.isSafeInteger(tabId) || tabId < 1)) {
      throw new Error('tabId must be a positive integer')
    }
    return this.serialized(owner, tabId, async () => {
      execution.signal?.throwIfAborted()
      const child = this.sessions.get(owner)
      if (child === undefined) return undefined
      /* v8 ignore next -- disposeAll clears sessions synchronously when disposal begins. */
      if (this.disposing) throw new BrowserError('the embedded browser is shutting down', 'BROWSER_DISPOSING')
      if (!this.browserSettings().controlEnabled) {
        throw new BrowserError('embedded browser control is disabled in settings', 'BROWSER_DISABLED')
      }
      if (this.permissions().browsing === 'ask' && execution.callId === undefined) {
        throw new BrowserError('reading the current page requires an active Browser call when browsing approval is enabled', 'BROWSER_POLICY_DENIED')
      }
      await this.approveBrowserPermission(owner, 'browsing', 'browser_current_page', undefined, execution)
      execution.signal?.throwIfAborted()
      this.checkPermission('browsing')
      const identity = browserPageIdentityOf(await child.call(
        'get_page_identity',
        tabId === undefined ? {} : { tabId },
        execution.signal,
      ))
      if (tabId !== undefined && identity.tabId !== tabId) {
        throw new Error('embedded browser returned a page identity for the wrong tab')
      }
      return identity
    })
  }

  /**
   * Capture the selected controlled page's visible viewport as a bounded PNG.
   * The base64 is transient: callers must consume it before persisting output.
   * @param owner - agent whose selected controlled tab is captured.
   * @param optionsOrExecution - screenshot options, or the legacy execution context for the two-argument form.
   * @param execution - tool-call identity and cancellation when screenshot options are supplied.
   * @returns the bounded screenshot payload.
   */
  async takeScreenshot(
    owner: Agent,
    optionsOrExecution: BrowserScreenshotOptions | BrowserExecutionContext = {},
    execution: BrowserExecutionContext = {},
  ): Promise<BrowserScreenshot> {
    const legacyExecution = 'callId' in optionsOrExecution || 'signal' in optionsOrExecution
    const options = legacyExecution ? {} : optionsOrExecution
    const actualExecution = legacyExecution ? optionsOrExecution : execution
    return this.serialized(owner, undefined, async () => {
      if (this.disposing) throw new BrowserError('the embedded browser is shutting down', 'BROWSER_DISPOSING')
      if (!this.browserSettings().controlEnabled) {
        throw new BrowserError('embedded browser control is disabled in settings', 'BROWSER_DISABLED')
      }
      await this.approveBrowserPermission(owner, 'browsing', 'browser_screenshot', undefined, actualExecution)
      const child = await this.session(owner, actualExecution.signal)
      this.checkPermission('browsing')
      return browserScreenshotOf(await child.call('browser_screenshot', { ...options }, actualExecution.signal))
    })
  }

  /**
   * Search only the bounded app-owned history after applying the model-access policy.
   * @param owner - agent whose browser profile owns the history ledger.
   * @param query - case-insensitive title/URL text, from 1 to 256 characters.
   * @param execution - tool-call identity and cancellation for approval.
   * @returns matching title, URL, and visit-time metadata.
   */
  async searchHistory(
    owner: Agent,
    query: string,
    execution: BrowserExecutionContext = {},
  ): Promise<BrowserHistorySearchEntry[]> {
    const normalized = query.trim()
    if (normalized.length === 0 || normalized.length > 256) {
      throw new Error('browser history query must contain 1 to 256 characters')
    }
    return this.serialized(owner, undefined, async () => {
      if (this.disposing) throw new BrowserError('the embedded browser is shutting down', 'BROWSER_DISPOSING')
      if (!this.browserSettings().controlEnabled) {
        throw new BrowserError('embedded browser control is disabled in settings', 'BROWSER_DISABLED')
      }
      execution.signal?.throwIfAborted()
      await this.approveBrowserPermission(owner, 'browsing', 'browser_history_search', undefined, execution)
      await this.approveHistorySearch(owner, normalized, execution)
      execution.signal?.throwIfAborted()
      const child = await this.session(owner, execution.signal)
      this.checkPermission('browsing')
      return historySearchResults(await child.call('search_browser_history', {
        query: normalized,
        limit: MAX_HISTORY_SEARCH_RESULTS,
      }))
    })
  }

  /**
   * Send one approved, bounded CDP command to the exact controlled tab.
   * @param owner - agent whose controlled browser owns the target tab.
   * @param method - CDP method name.
   * @param params - JSON parameters for the method.
   * @param tabId - optional positive controlled-tab id; omission uses the selected tab.
   * @param execution - tool-call identity and cancellation for approval.
   * @returns the bounded method name and JSON result.
   */
  async sendCdpCommand(
    owner: Agent,
    method: string,
    params: unknown,
    tabId: number | undefined,
    execution: BrowserExecutionContext = {},
  ): Promise<BrowserCdpCommandResult> {
    const boundedParams = boundedCdpParams(method, params)
    if (tabId !== undefined && (!Number.isSafeInteger(tabId) || tabId < 1)) {
      throw new Error('tabId must be a positive integer')
    }
    return this.serialized(owner, tabId, async () => {
      this.assertCdpAccess()
      await this.approveBrowserPermission(owner, 'browsing', 'browser_cdp_command', undefined, execution)
      if (method === 'DOM.setFileInputFiles' || method === 'Input.dispatchDragEvent') {
        throw new BrowserError('Use browser_upload_file for local file transfers.', 'BROWSER_POLICY_DENIED')
      }
      execution.signal?.throwIfAborted()
      const child = await this.session(owner, execution.signal)
      const target = await child.call('get_cdp_target', tabId === undefined ? {} : { tabId }) as {
        origin?: unknown
        tabId?: unknown
      }
      if (typeof target.origin !== 'string' || !Number.isSafeInteger(target.tabId)) {
        throw new BrowserError('browser CDP target is unavailable', 'BROWSER_POLICY_DENIED')
      }
      await this.approveCdpAccess(
        owner,
        'browser_cdp_command',
        `Run CDP ${method} on ${target.origin} in tab [${target.tabId as number}].`,
        execution,
      )
      execution.signal?.throwIfAborted()
      this.checkPermission('browsing')
      return boundedCdpResult(method, await child.call('cdp_command', {
        method,
        params: boundedParams,
        expectedOrigin: target.origin,
        tabId: target.tabId,
      }))
    })
  }

  /**
   * Read a bounded cursor page of events captured from an approved controlled tab.
   * @param owner - agent whose controlled browser owns the target tab.
   * @param options - cursor, page-size, method filter, and optional tab id.
   * @param execution - tool-call identity and cancellation for approval.
   * @returns the bounded events and the next cursor value.
   */
  async readCdpEvents(
    owner: Agent,
    options: { afterSequence?: number; limit?: number; method?: string; tabId?: number },
    execution: BrowserExecutionContext = {},
  ): Promise<BrowserCdpEventPage> {
    const afterSequence = options.afterSequence ?? 0
    const limit = options.limit ?? MAX_CDP_EVENT_RESULTS
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error('CDP event cursor must be a non-negative integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CDP_EVENT_RESULTS) {
      throw new Error(`CDP event limit must be from 1 to ${MAX_CDP_EVENT_RESULTS}`)
    }
    if (options.method !== undefined && (options.method.length > 128 || !CDP_METHOD.test(options.method))) {
      throw new Error('CDP event method filter must use Domain.event syntax')
    }
    if (options.tabId !== undefined && (!Number.isSafeInteger(options.tabId) || options.tabId < 1)) {
      throw new Error('tabId must be a positive integer')
    }
    return this.serialized(owner, options.tabId, async () => {
      this.assertCdpAccess()
      await this.approveBrowserPermission(owner, 'browsing', 'browser_cdp_read_events', undefined, execution)
      execution.signal?.throwIfAborted()
      const child = await this.session(owner, execution.signal)
      const target = await child.call('get_cdp_target', options.tabId === undefined ? {} : { tabId: options.tabId }) as {
        origin?: unknown
        tabId?: unknown
      }
      if (typeof target.origin !== 'string' || !Number.isSafeInteger(target.tabId)) {
        throw new BrowserError('browser CDP target is unavailable', 'BROWSER_POLICY_DENIED')
      }
      await this.approveCdpAccess(
        owner,
        'browser_cdp_read_events',
        `Read CDP events from ${target.origin} in tab [${target.tabId as number}].`,
        execution,
      )
      execution.signal?.throwIfAborted()
      this.checkPermission('browsing')
      return boundedCdpEventPage(await child.call('cdp_read_events', {
        afterSequence,
        limit,
        ...options.method === undefined ? {} : { method: options.method },
        expectedOrigin: target.origin,
        tabId: target.tabId,
      }))
    })
  }

  /**
   * Close one owner's window now, if it has one.
   * @param owner - agent whose window to close.
   * @returns true when a window was open and is now closed.
   */
  async close(owner: Agent): Promise<boolean> {
    const child = this.sessions.get(owner)
    const launch = this.launches.get(owner)
    if (child === undefined && launch === undefined) return false
    this.sessions.delete(owner)
    this.launches.delete(owner)
    const children = new Set<BrowserChild>()
    if (child !== undefined) children.add(child)
    if (launch !== undefined) {
      launch.controller.abort()
      try {
        children.add(await launch.ready)
      } catch {
        // A failed launch owns no browser process that close() can release.
      }
    }
    await Promise.all([...children].map(async current => current.close()))
    return true
  }

  private assertCdpAccess(): void {
    if (this.disposing) throw new BrowserError('the embedded browser is shutting down', 'BROWSER_DISPOSING')
    if (!this.browserSettings().controlEnabled) {
      throw new BrowserError('embedded browser control is disabled in settings', 'BROWSER_DISABLED')
    }
    if (!this.fullCdpAccess) {
      throw new BrowserError('full browser CDP access is disabled by settings or organization policy', 'BROWSER_POLICY_DENIED')
    }
  }

  /** Serialize one tab while letting different explicit tab targets overlap. */
  private async serialized<T>(owner: Agent, tabId: number | undefined, operation: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(owner)
    if (queue === undefined) {
      queue = { barrier: READY, tabs: new Map() }
      this.queues.set(owner, queue)
    }
    const dependencies = tabId === undefined
      ? [queue.barrier, ...queue.tabs.values()]
      : [queue.barrier, queue.tabs.get(tabId) ?? READY]
    const run = Promise.all(dependencies).then(operation)
    const tail = run.then(() => undefined, () => undefined)
    if (tabId === undefined) {
      queue.barrier = tail
      queue.tabs.clear()
    } else {
      queue.tabs.set(tabId, tail)
    }
    try {
      return await run
    } finally {
      if (tabId === undefined && queue.barrier === tail) queue.barrier = READY
      if (tabId !== undefined && queue.tabs.get(tabId) === tail) queue.tabs.delete(tabId)
      if (queue.barrier === READY && queue.tabs.size === 0) this.queues.delete(owner)
    }
  }

  /** Reuse this owner's window, or start the one it does not have yet. */
  private session(owner: Agent, signal?: AbortSignal): Promise<BrowserChild> {
    signal?.throwIfAborted()
    const existing = this.sessions.get(owner)
    if (existing !== undefined) return Promise.resolve(existing)
    const launching = this.launches.get(owner)
    if (launching !== undefined) return launching.ready
    this.ensureOwnerCleanup(owner)
    const settingsAtLaunch = nativeSettings(this.browserSettings(), this.settings.allowFullCdpAccess)
    const controller = new AbortController()
    const ready = launchBrowser({
      signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
      ...this.settings,
      ...settingsAtLaunch,
      spawnChild: this.spawnChild,
      onPermission: async ({ kind, origin, filename }, signal) => {
        if (kind !== 'media') {
          try {
            await this.approveBrowserPermission(owner, kind === 'download' ? 'downloads' : 'browsing',
              kind === 'download' ? 'browser_download' : 'browser_navigate',
              filename === undefined ? origin : `${filename} from ${origin}`, { signal })
            return 'once'
          } catch {
            // Policy denial, cancellation, and an unavailable answerer all deny this native request.
            return undefined
          }
        }
        const questions = this.ctx.get('userQuestions')
        if (questions === undefined || !this.browserSettings().controlEnabled) return undefined
        const answer = await questions.ask({
          agent: owner,
          signal,
          questions: [{
            id: 'browser-permission',
            header: 'Camera and microphone',
            question: `Allow ${origin} to use camera or microphone?`,
            options: [
              { label: 'Allow once', description: 'Allow only this request.' },
              { label: 'Always allow', description: 'Remember this exact website in Browser settings.' },
              { label: 'Block', description: 'Block this permission for this website.' },
            ],
          }],
        })
        const selected = answer.answers.find(item => item.id === 'browser-permission')
        if (signal.aborted || !this.browserSettings().controlEnabled
          || selected?.custom !== undefined || selected?.selected.length !== 1) return undefined
        switch (selected.selected[0]) {
          case 'Allow once': return 'once'
          case 'Always allow': return 'always'
          case 'Block': return 'block'
          default: return undefined
        }
      },
      onPageAgentLlm: async (request) => {
        if (!this.browserSettings().controlEnabled) {
          return Promise.reject(new BrowserError(
            'embedded browser control is disabled in settings',
            'BROWSER_DISABLED',
          ))
        }
        await this.approveBrowserPermission(owner, 'browsing', 'page_agent_run', undefined, {})
        const result = await executePageAgentLlm(owner, request)
        this.checkPermission('browsing')
        return result
      },
    }).then(async (child) => {
      if (this.launches.get(owner)?.ready !== ready) return child
      this.launches.delete(owner)
      /* v8 ignore next 4 -- disposeAll clears launches before awaiting; an ending launch returns at the ownership guard above. */
      if (this.disposing) {
        await child.close()
        throw new BrowserError('the embedded browser is shutting down', 'BROWSER_DISPOSING')
      }
      const currentSettings = nativeSettings(this.browserSettings(), this.settings.allowFullCdpAccess)
      if (JSON.stringify(currentSettings) !== JSON.stringify(settingsAtLaunch)) {
        await child.call('configure_browser', currentSettings)
      }
      this.sessions.set(owner, child)
      // Whoever ends the child — the user closing the window, a crash, our own
      // close() — the next action starts a fresh one instead of talking to it.
      void child.closed.then(() => {
        if (this.sessions.get(owner) === child) this.sessions.delete(owner)
      })
      return child
    }, (error: unknown) => {
      if (this.launches.get(owner)?.ready === ready) this.launches.delete(owner)
      throw error
    })
    this.launches.set(owner, { ready, controller })
    return ready
  }

  /** Revoke detached PageAgent loops when the user disables browser control. */
  private stopPageAgents(): void {
    for (const child of new Set(this.sessions.values())) {
      void child.call('get_browser_state', {})
        .then(async (state) => {
          await Promise.all((state as BrowserState).tabs.map(async (tab) => {
            await child.call('page_agent_stop', { tabId: tab.id })
          }))
        })
        .catch((error: unknown) => {
          if (!this.disposing) this.ctx.logger.warn(`browser-electron: failed to stop PageAgent after control was disabled: ${String(error)}`)
        })
    }
  }

  /** Apply profile-owned preferences to every already-connected Electron controller. */
  private configureChildren(): void {
    const settings = nativeSettings(this.browserSettings(), this.settings.allowFullCdpAccess)
    for (const child of new Set(this.sessions.values())) {
      void child.call('configure_browser', settings).catch((error: unknown) => {
        if (!this.disposing) this.ctx.logger.warn(`browser-electron: failed to apply Browser settings: ${String(error)}`)
      })
    }
  }

  private permissions(): BrowserPermissions {
    const settings = this.browserSettings()
    return settings.browserPermissions ?? {
      browsing: settings.navigationPolicy,
      downloads: settings.downloadPolicy,
      uploads: settings.uploadPolicy,
    }
  }

  /** Recheck revocation after asynchronous preparation and before dispatch. */
  private checkPermission(capability: keyof BrowserPermissions): BrowserDecision {
    if (!this.browserSettings().controlEnabled) {
      throw new BrowserError('embedded browser control is disabled in settings', 'BROWSER_DISABLED')
    }
    const policy = this.permissions()[capability]
    this.ctx.logger.debug('browser permission: capability=%s decision=%s source=general', capability, policy)
    if (policy === 'block') {
      throw new BrowserError(`${capability} is blocked by Browser permissions.`, 'BROWSER_POLICY_DENIED')
    }
    return policy
  }

  /** Global capability decisions never depend on a destination or create a site rule. */
  private async approveBrowserPermission(
    owner: Agent,
    capability: keyof BrowserPermissions,
    action: string,
    context: string | undefined,
    execution: BrowserExecutionContext,
  ): Promise<void> {
    execution.signal?.throwIfAborted()
    const policy = this.checkPermission(capability)
    this.ctx.logger.debug('browser permission: action=%s capability=%s decision=%s source=general', action, capability, policy)
    if (policy === 'allow') return
    const related = capability === 'browsing' && execution.callId !== undefined
      ? owner.session.events.findLast(event => event.type === 'tool/call'
        ? event.data.callId === execution.callId
        : event.type === 'tool/result' && event.data.message.source.callId === execution.callId)
      : undefined
    const call = related?.type === 'tool/call' ? related : undefined
    // The logged invocation, rather than a reusable model id, owns this approval.
    if (call !== undefined && this.browsingApprovals.get(owner) === call) return
    const requestedAction = call?.data.name ?? action
    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      throw new BrowserError(`${capability} requires approval, but no approval service is available`, 'BROWSER_POLICY_DENIED')
    }
    const outcome = await approval.request({
      agent: owner,
      toolName: requestedAction,
      reason: `Browser permissions: ${capability}. Action: ${requestedAction}.${context === undefined ? '' : ` ${context}`}`,
      ...execution,
    })
    execution.signal?.throwIfAborted()
    if (outcome !== 'allowed-once' || !this.browserSettings().controlEnabled || this.permissions()[capability] === 'block') {
      throw new BrowserError(`${capability} was not approved (${outcome})`, 'BROWSER_POLICY_DENIED')
    }
    if (call !== undefined) this.browsingApprovals.set(owner, call)
  }

  /** Bind upload approval to the resolved file and destination. */
  private async approveUpload(
    owner: Agent,
    filePath: string,
    target: { origin: string; tabId: number; index: number },
    execution: BrowserExecutionContext,
  ): Promise<void> {
    await this.approveBrowserPermission(owner, 'uploads', 'browser_upload_file',
      `Upload ${filePath} to ${target.origin} in tab [${target.tabId}] through input [${target.index}].`, execution)
  }

  /** Apply the separate sensitive-history policy before any ledger row crosses to the model. */
  private async approveHistorySearch(
    owner: Agent,
    query: string,
    execution: BrowserExecutionContext,
  ): Promise<void> {
    const policy = this.browserSettings().historyAccessPolicy
    if (policy === 'allow') return
    if (policy === 'block') {
      throw new BrowserError('browser history access is blocked in settings', 'BROWSER_POLICY_DENIED')
    }
    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      throw new BrowserError('browser history access requires approval, but no approval service is available', 'BROWSER_POLICY_DENIED')
    }
    const outcome = await approval.request({
      agent: owner,
      toolName: 'browser_history_search',
      reason: `Search sensitive Browser history for ${JSON.stringify(query)}.`,
      ...execution.callId === undefined ? {} : { callId: execution.callId },
      ...execution.signal === undefined ? {} : { signal: execution.signal },
    })
    if (outcome !== 'allowed-once') {
      throw new BrowserError(`browser history search was not approved (${outcome})`, 'BROWSER_POLICY_DENIED')
    }
  }

  /** Full CDP always requires a fresh decision bound to the tab, origin, and method. */
  private async approveCdpAccess(
    owner: Agent,
    toolName: 'browser_cdp_command' | 'browser_cdp_read_events',
    reason: string,
    execution: BrowserExecutionContext,
  ): Promise<void> {
    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      throw new BrowserError('full browser CDP access requires approval, but no approval service is available', 'BROWSER_POLICY_DENIED')
    }
    const outcome = await approval.request({
      agent: owner,
      toolName,
      reason,
      ...execution.callId === undefined ? {} : { callId: execution.callId },
      ...execution.signal === undefined ? {} : { signal: execution.signal },
    })
    if (outcome !== 'allowed-once') {
      throw new BrowserError(`browser CDP command was not approved (${outcome})`, 'BROWSER_POLICY_DENIED')
    }
  }

  private ensureOwnerCleanup(owner: Agent): void {
    if (this.ownerCleanups.has(owner)) return
    const detach = owner.ctx.effect(() => async () => {
      this.ownerCleanups.delete(owner)
      await this.close(owner)
    }, 'browser.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  private async disposeAll(): Promise<void> {
    this.disposing = true
    const children = [...this.sessions.values()]
    const launches = [...this.launches.values()]
    for (const launch of launches) launch.controller.abort()
    this.sessions.clear()
    this.launches.clear()
    const cleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    await Promise.all(cleanups.map(async detach => detach()))
    const launched = (await Promise.allSettled(launches.map(launch => launch.ready)))
      .flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    await Promise.all([...new Set([...children, ...launched])].map(async child => child.close()))
  }
}

export default BrowserSessionService
