/**
 * Owner-scoped embedded browser. One agent gets one Electron window, started
 * on its first action and closed with the agent, driven through the upstream
 * PageAgent runtime running in the view's preload.
 * @module @bosch/bh-browser-electron
 */

import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@bosch/cordis'
import z from '@bosch/schemastery'
import type { Agent } from '@bosch/bh-agent'
import { resolveBhHome } from '@bosch/bh-home-paths'
import { launchBrowser } from './child.ts'
import type { BrowserChild, BrowserChildProcess } from './child.ts'
import { executePageAgentLlm } from './page-agent-llm.ts'
import { BrowserError } from './types.ts'
import type { ActionResult, BrowserAction, BrowserOutcome, BrowserState } from './types.ts'

export { launchBrowser, resolveElectronPath } from './child.ts'
export type { BrowserChild, BrowserChildProcess, LaunchOptions, PageAgentLlmRequest } from './child.ts'
export { BrowserError } from './types.ts'
export type { ActionResult, BrowserAction, BrowserErrorCode, BrowserOutcome, BrowserState, BrowserTabState } from './types.ts'

declare module '@bosch/cordis' {
  interface Context {
    browsers: BrowserSessionService
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
  /** Explicit Electron binary; omitted resolves the optional `electron` package. */
  electronPath?: string
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

/** Whether a direct user named this exact path in the current open turn. */
function containsPathLiteral(text: string, filePath: string): boolean {
  let offset = text.indexOf(filePath)
  while (offset !== -1) {
    const before = text[offset - 1]
    const after = text[offset + filePath.length]
    const isBoundary = (value: string | undefined) => value === undefined || /[\s"'`]/u.test(value)
    if (isBoundary(before) && isBoundary(after)) return true
    offset = text.indexOf(filePath, offset + 1)
  }
  return false
}

function userAuthorizedUpload(owner: Agent, filePath: string): boolean {
  const events = owner.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return false
    if (event?.type !== 'turn/start') continue
    return events.slice(index + 1).some(candidate =>
      candidate.type === 'user/message'
      && candidate.data.source.kind === 'user'
      && candidate.data.content.some(block => block.type === 'text' && containsPathLiteral(block.text, filePath)),
    )
  }
  return false
}

/** Authorize, resolve, and validate the one host file an upload may expose. */
async function prepareAction(owner: Agent, action: BrowserAction): Promise<BrowserAction> {
  if (action.method !== 'upload_file') return action
  if (!userAuthorizedUpload(owner, action.filePath)) {
    throw new Error('upload file path must appear literally in a direct user message in the current open turn')
  }
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
    electronPath: z.string(),
  })

  private readonly sessions = new Map<Agent, BrowserChild>()
  private readonly launches = new Map<Agent, Promise<BrowserChild>>()
  private readonly queues = new WeakMap<Agent, OwnerQueue>()
  private readonly ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  private readonly settings: ResolvedSettings
  private disposing = false

  /** Test seam standing in for the real Electron spawn. */
  spawnChild?: (command: string, args: string[]) => BrowserChildProcess

  /** Whether this host explicitly enabled the experimental JavaScript action. */
  get experimentalScriptExecution(): boolean {
    return this.settings.experimentalScriptExecution
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'browsers')
    // Schemastery filled every default before construction, so only the
    // profile path is resolved here — deliberately per boot, because its
    // default reads the harness home rather than a constant.
    const initialUrl = homeUrl(config.homeUrl)
    this.settings = {
      ...config as Omit<ResolvedSettings, 'userDataDir'>,
      userDataDir: config.userDataDir ?? join(resolveBhHome(), 'browser-profile'),
      ...initialUrl === undefined ? {} : { homeUrl: initialUrl },
    }
    ctx.effect(() => () => this.disposeAll(), 'browser teardown')
  }

  /**
   * Do one thing to an owner's page and report the page afterwards.
   *
   * The trailing state read is not a convenience: PageController indexes
   * elements while building the tree, so the snapshot both answers the caller
   * and leaves the next action addressable. Explicit targets are ordered per
   * tab and may overlap across tabs; implicit and lifecycle actions are barriers.
   * @param owner - agent whose window this is; its first call starts one.
   * @param action - what to do, in page-agent's own vocabulary.
   * @returns the action's report, omitted for a plain state read, plus the state.
   */
  async perform(owner: Agent, action: BrowserAction): Promise<BrowserOutcome> {
    return this.serialized(owner, queueTabId(action), async () => {
      if (this.disposing) throw new BrowserError('the embedded browser is shutting down', 'BROWSER_DISPOSING')
      const prepared = await prepareAction(owner, action)
      if (prepared.method === 'execute_javascript' && !this.settings.experimentalScriptExecution) {
        throw new Error('experimental browser JavaScript is disabled by the host')
      }
      const child = await this.session(owner)
      const { method, ...args } = prepared
      const result = method === 'get_browser_state'
        ? undefined
        : await child.call(method, args) as ActionResult
      const waitForReady = prepared.method === 'get_browser_state'
        || prepared.method === 'navigate'
        || prepared.method === 'back'
        || prepared.method === 'click_element'
        || prepared.method === 'press'
        || prepared.method === 'wait'
        || prepared.method === 'open_new_tab'
        || prepared.method === 'switch_to_tab'
        || prepared.method === 'close_tab'
      const tabId = stateTabId(prepared)
      const state = await child.call('get_browser_state', {
        waitForReady,
        ...tabId === undefined ? {} : { tabId },
      }) as BrowserState
      return result === undefined ? { state } : { action: result, state }
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
      try {
        children.add(await launch)
      } catch {
        // A failed launch owns no browser process that close() can release.
      }
    }
    await Promise.all([...children].map(async current => current.close()))
    return true
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
  private session(owner: Agent): Promise<BrowserChild> {
    const existing = this.sessions.get(owner)
    if (existing !== undefined) return Promise.resolve(existing)
    const launching = this.launches.get(owner)
    if (launching !== undefined) return launching
    this.ensureOwnerCleanup(owner)
    const ready = launchBrowser({
      ...this.settings,
      spawnChild: this.spawnChild,
      onPageAgentLlm: request => executePageAgentLlm(owner, request),
    }).then(async (child) => {
      if (this.launches.get(owner) !== ready) return child
      this.launches.delete(owner)
      if (this.disposing) {
        await child.close()
        throw new BrowserError('the embedded browser is shutting down', 'BROWSER_DISPOSING')
      }
      this.sessions.set(owner, child)
      // Whoever ends the child — the user closing the window, a crash, our own
      // close() — the next action starts a fresh one instead of talking to it.
      void child.closed.then(() => {
        if (this.sessions.get(owner) === child) this.sessions.delete(owner)
      })
      return child
    }, (error: unknown) => {
      if (this.launches.get(owner) === ready) this.launches.delete(owner)
      throw error
    })
    this.launches.set(owner, ready)
    return ready
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
    this.sessions.clear()
    this.launches.clear()
    const cleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    await Promise.all(cleanups.map(async detach => detach()))
    const launched = (await Promise.allSettled(launches))
      .flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    await Promise.all([...new Set([...children, ...launched])].map(async child => child.close()))
  }
}

export default BrowserSessionService
