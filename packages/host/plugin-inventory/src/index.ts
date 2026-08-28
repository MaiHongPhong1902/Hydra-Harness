/** Runtime plugin inventory plus shared user-setting enablement controls. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type FiberState } from '@bosch/cordis'
import type { Entry } from '@bosch/cordis-plugin-loader'
import type { Include } from '@bosch/cordis-plugin-include'
import { readProfileManifest, resolveProfileDir } from '@bosch/bh-app-boot'
import { settingsNamespace, type SettingsScope } from '@bosch/bh-settings'
import { TypertRemoteService, Remote } from '@bosch/bh-typert-protocol'
import z from '@bosch/schemastery'
import { z as zod } from 'zod'
import type {
  AddPluginMarketplaceRequest,
  InstallMarketplacePluginRequest,
  MarketplacePluginId,
  MarketplacePluginInstallResult,
  MarketplacePluginView,
  PluginEnablementRequest,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
  PluginMarketplaceSnapshot,
  PluginMarketplaceView,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Bind the browser-visible id to the exact package the user reviewed. */
function marketplacePluginId(plugin: { id: string; package: string; version: string }): MarketplacePluginId {
  return createHash('sha256')
    .update(plugin.id).update('\0')
    .update(plugin.package).update('\0')
    .update(plugin.version)
    .digest('hex') as MarketplacePluginId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

const PLUGIN_SETTINGS_NAMESPACE = settingsNamespace('plugins')
const MARKETPLACE_SETTINGS_NAMESPACE = settingsNamespace('plugin-marketplaces')
const HMR_MODULE = '@bosch/cordis-plugin-hmr'
const MAX_MARKETPLACE_BYTES = 1024 * 1024
const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_VERSION_PATTERN =
  // eslint-disable-next-line @stylistic/max-len -- Keep the SemVer grammar contiguous.
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

const MarketplaceDocumentSchema = zod.object({
  name: zod.string().trim().min(1).max(80),
  plugins: zod.array(zod.object({
    id: zod.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    name: zod.string().trim().min(1).max(100),
    description: zod.string().trim().min(1).max(500),
    package: zod.string().trim().max(214).regex(PACKAGE_NAME_PATTERN)
      .refine(name => name !== 'node_modules' && name !== 'favicon.ico'),
    version: zod.string().trim().regex(EXACT_VERSION_PATTERN),
  }).strict()).max(500),
}).strict().superRefine((marketplace, refinement) => {
  const ids = new Set<string>()
  marketplace.plugins.forEach((plugin, index) => {
    if (ids.has(plugin.id)) {
      refinement.addIssue({
        code: 'custom',
        message: `duplicate plugin id ${JSON.stringify(plugin.id)}`,
        path: ['plugins', index, 'id'],
      })
    }
    ids.add(plugin.id)
  })
})

type MarketplaceDocument = zod.infer<typeof MarketplaceDocumentSchema>

interface PluginSettings {
  enabled: Record<string, boolean>
}

const PluginSettingsSchema: z<PluginSettings> = z.object({
  enabled: z.dict(z.boolean()).default({}),
})

interface MarketplaceSettings {
  sources: string[]
}

const MarketplaceSettingsSchema: z<MarketplaceSettings> = z.object({
  sources: z.array(z.string()).max(20).default([]),
})

interface LoadedMarketplace {
  source: string
  document: MarketplaceDocument
}

/** Accept public HTTPS catalogs plus loopback HTTP for local development. */
function normalizeMarketplaceSource(source: string): string {
  if (source.length > 2048) throw new Error('pluginInventory: marketplace URL is too long')
  let url: URL
  try {
    url = new URL(source)
  } catch (cause) {
    throw new Error('pluginInventory: marketplace source must be an absolute URL', { cause })
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('pluginInventory: marketplace source must use HTTPS or loopback HTTP')
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('pluginInventory: marketplace source cannot contain credentials or a fragment')
  }
  return url.href
}

/** Fetch and validate one bounded marketplace document at the Host boundary. */
async function loadMarketplace(source: string): Promise<LoadedMarketplace> {
  const normalized = normalizeMarketplaceSource(source)
  const response = await fetch(normalized, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`pluginInventory: marketplace ${normalized} returned HTTP ${String(response.status)}`)
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MARKETPLACE_BYTES) {
    throw new Error(`pluginInventory: marketplace ${normalized} exceeds ${String(MAX_MARKETPLACE_BYTES)} bytes`)
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  if (reader !== undefined) {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > MAX_MARKETPLACE_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new Error(`pluginInventory: marketplace ${normalized} exceeds ${String(MAX_MARKETPLACE_BYTES)} bytes`)
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const body = Buffer.concat(chunks, total).toString('utf8')
  return { source: normalized, document: MarketplaceDocumentSchema.parse(JSON.parse(body) as unknown) }
}

/** Invoke this process's existing `bh plugin` command without a shell. */
function runProfilePlugin(
  profileDir: string,
  pluginArgs: readonly string[],
  failure: string,
): Promise<void> {
  const cliEntry = process.argv[1]
  if (cliEntry === undefined) throw new Error('pluginInventory: current bh CLI entry is unavailable')
  const sourceArgs: string[] = []
  if (cliEntry.endsWith('.ts')) {
    for (let index = 0; index < process.execArgv.length; index += 1) {
      const argument = process.execArgv[index] as string
      if (argument.startsWith('--import=')) sourceArgs.push(argument)
      if (argument === '--import' && process.execArgv[index + 1] !== undefined) {
        sourceArgs.push(argument, process.execArgv[index + 1] as string)
        index += 1
      }
    }
  }
  const args = [
    ...sourceArgs,
    cliEntry,
    'plugin', '--profile', basename(profileDir),
    ...pluginArgs,
  ]
  return new Promise((resolvePromise, reject) => {
    execFile(process.execPath, args, {
      cwd: profileDir,
      encoding: 'utf8',
      maxBuffer: MAX_MARKETPLACE_BYTES,
      windowsHide: true,
      ...(process.versions.electron === undefined
        ? {}
        : { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }),
    }, (error, _stdout, stderr) => {
      if (error === null) {
        resolvePromise()
        return
      }
      const detail = stderr.trim().split(/\r?\n/u)[0]
      reject(new Error(
        `pluginInventory: ${failure}${detail === undefined || detail === '' ? '' : `: ${detail}`}`,
        { cause: error },
      ))
    })
  })
}

/** Plugin ids that the assembled product requires to remain enabled. */
export interface Config {
  /** Direct root entry ids that cannot be disabled in-app. */
  protectedEntryIds?: string[]
  /** Entry ids owned by another composition plane and omitted from this inventory. */
  compositionEntryIds?: string[]
}

interface EntryState {
  entry: Entry
  disabled: boolean | null | undefined
  config: unknown
}

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader', 'settings']
  static Config: z<Config> = z.object({
    protectedEntryIds: z.array(z.string()).default([]),
    compositionEntryIds: z.array(z.string()).default([]),
  })

  private readonly protectedEntryIds: ReadonlySet<string>
  private readonly compositionEntryIds: ReadonlySet<string>
  private readonly settings: SettingsScope<PluginSettings>
  private readonly marketplaceSettings: SettingsScope<MarketplaceSettings>
  private readonly defaultEnabled = new Map<string, boolean>()
  private readonly originalConfigs = new Map<string, unknown>()
  private readonly appliedSettings = new Set<string>()
  private mutationTail: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'pluginInventory')
    this.protectedEntryIds = new Set(config.protectedEntryIds)
    this.compositionEntryIds = new Set(config.compositionEntryIds)
    this.settings = ctx.settings.register(PLUGIN_SETTINGS_NAMESPACE, PluginSettingsSchema)
    this.marketplaceSettings = ctx.settings.register(MARKETPLACE_SETTINGS_NAMESPACE, MarketplaceSettingsSchema)
  }

  protected async [Service.init](): Promise<void> {
    const rootInclude = this.rootInclude()
    if (rootInclude === undefined) return
    const representatives = this.representatives(rootInclude)
    for (const entry of representatives.values()) {
      this.defaultEnabled.set(entry.options.name, !entry.disabled && !this.isHmrWatchOnly(entry))
      this.originalConfigs.set(entry.options.name, structuredClone(entry.options.config))
    }
    for (const entry of representatives.values()) {
      if (entry.disabled && this.protectedEntryIds.has(entry.options.id)) {
        await this.updateModule(entry, true)
      }
    }
    await this.applySettings(this.settings.get().enabled)
    this.ctx.effect(
      () => this.settings.watch(next => this.enqueue(() => this.applySettings(next.enabled))),
      'pluginInventory.settingsWatch',
    )
  }

  private rootInclude(): Include | undefined {
    return Object.values(this.ctx.loader.store)
      .map(entry => entry.subtree)
      .find((tree): tree is Include => tree !== undefined
        && 'filename' in tree
        && typeof tree.filename === 'string')
  }

  /** Resolve the active root Include back to the profile directory the CLI owns. */
  private profileDir(): string {
    const filename = this.rootInclude()?.filename
    if (typeof filename !== 'string') throw new Error('pluginInventory: active profile root is unavailable')
    const path = filename.startsWith('file:') ? fileURLToPath(filename) : filename
    const actual = resolve(dirname(path))
    const expected = resolve(resolveProfileDir(basename(actual)))
    if (actual !== expected) {
      throw new Error(`pluginInventory: active root ${path} is not a managed bh profile`)
    }
    return expected
  }

  /** Bundle names already active in the persisted profile stack. */
  private installedBundles(profileDir: string): ReadonlySet<string> {
    const manifest = readProfileManifest('pluginInventory', profileDir)
    return new Set(manifest.bh?.profile?.bundles ?? [])
  }

  /** Project persisted sources without letting one unavailable catalog hide the others. */
  private async marketplaceSnapshot(): Promise<PluginMarketplaceSnapshot> {
    const sources = this.marketplaceSettings.get().sources
    if (sources.length === 0) return { marketplaces: [] }
    const installed = this.installedBundles(this.profileDir())
    const marketplaces = await Promise.all(sources.map(async (source): Promise<PluginMarketplaceView> => {
      try {
        const loaded = await loadMarketplace(source)
        const plugins: MarketplacePluginView[] = loaded.document.plugins.map(plugin => ({
          id: marketplacePluginId(plugin),
          name: plugin.name,
          description: plugin.description,
          packageName: plugin.package,
          version: plugin.version,
          installed: installed.has(plugin.package),
        }))
        return { status: 'ready', source: loaded.source, name: loaded.document.name, plugins }
      } catch {
        return { status: 'unavailable', source }
      }
    }))
    return { marketplaces }
  }

  private moduleEntries(moduleName: string): Entry[] {
    const entries: Entry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (!entry.options.group
        && !this.compositionEntryIds.has(entry.options.id)
        && entry.options.name === moduleName) entries.push(entry)
    }
    return entries
  }

  /** One logical row per module, preferring the profile-owned entry. */
  private representatives(rootInclude: Include | undefined): Map<string, Entry> {
    const entries = new Map<string, Entry>()
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group || this.compositionEntryIds.has(entry.options.id)) continue
      const current = entries.get(entry.options.name)
      if (current === undefined
        || (entry.parent.tree === rootInclude && current.parent.tree !== rootInclude)
        || (this.protectedEntryIds.has(entry.options.id)
          && !this.protectedEntryIds.has(current.options.id))) {
        entries.set(entry.options.name, entry)
      }
    }
    return entries
  }

  private isToggleable(entry: Entry, rootInclude = this.rootInclude()): boolean {
    return rootInclude !== undefined
      && entry.parent.tree === rootInclude
      && !this.moduleEntries(entry.options.name)
        .some(candidate => this.protectedEntryIds.has(candidate.options.id))
  }

  private enabled(entry: Entry): boolean {
    if (!this.isToggleable(entry)) return !entry.disabled
    return this.settings.get().enabled[entry.options.name]
      ?? this.defaultEnabled.get(entry.options.name)
      ?? !entry.disabled
  }

  private isHmrWatchOnly(entry: Entry): boolean {
    const config = entry.options.config as { root?: unknown } | undefined
    return entry.options.name === HMR_MODULE && Array.isArray(config?.root) && config.root.length === 0
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(task, task)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async restore(states: readonly EntryState[]): Promise<void> {
    for (const state of states.toReversed()) {
      await state.entry.update({
        disabled: state.disabled ?? null,
        config: state.config ?? null,
      })
    }
  }

  /** Keep one configured instance active; HMR's disabled state remains watch-only. */
  private async updateModule(entry: Entry, enabled: boolean): Promise<EntryState[]> {
    const candidates = this.moduleEntries(entry.options.name)
    const states = candidates.map(candidate => ({
      entry: candidate,
      disabled: candidate.options.disabled,
      config: candidate.options.config as unknown,
    }))
    try {
      for (const candidate of candidates) {
        if (candidate !== entry && !candidate.disabled) await candidate.update({ disabled: true })
      }
      if (entry.options.name === HMR_MODULE) {
        const original = this.originalConfigs.get(entry.options.name)
        const config = { ...(original as Record<string, unknown> | undefined) }
        if (enabled) delete config.root
        else config.root = []
        await entry.update({ disabled: null, config })
      } else {
        await entry.update({ disabled: enabled ? null : true })
      }
      return states
    } catch (error) {
      try {
        await this.restore(states)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `pluginInventory: failed to update and roll back ${entry.options.name}`)
      }
      throw error
    }
  }

  private async applySettings(enabled: Readonly<Record<string, boolean>>): Promise<void> {
    const rootInclude = this.rootInclude()
    const representatives = this.representatives(rootInclude)
    const modules = new Set([...this.appliedSettings, ...Object.keys(enabled)])
    this.appliedSettings.clear()
    for (const moduleName of Object.keys(enabled)) this.appliedSettings.add(moduleName)
    const failures: unknown[] = []
    for (const moduleName of modules) {
      const entry = representatives.get(moduleName)
      if (entry === undefined) continue
      if (!this.isToggleable(entry, rootInclude)) continue
      const desired = enabled[moduleName]
        ?? this.defaultEnabled.get(moduleName)
        ?? !entry.disabled
      try {
        await this.updateModule(entry, desired)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'pluginInventory: failed to apply plugin settings')
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   * @returns Current non-group Loader entries in Loader order.
   */
  @Remote('list')
  list(): PluginInventorySnapshot {
    const entries: PluginInventoryEntry[] = []
    const rootInclude = this.rootInclude()
    for (const entry of this.representatives(rootInclude).values()) {
      const enabled = this.enabled(entry)
      const active = enabled
        ? this.moduleEntries(entry.options.name).find(candidate => !candidate.disabled && candidate.fiber !== undefined)
        : undefined
      const fiber = active?.fiber
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled,
        toggleable: this.isToggleable(entry, rootInclude),
        fiberPhase: fiber === undefined ? null : FIBER_PHASE[fiber.state],
      })
    }
    return { entries }
  }

  /**
   * Apply one module-wide live state, then persist it in the shared settings
   * document. A failed settings write rolls the Loader entries back.
   * @param request - target entry and desired enablement.
   * @returns A fresh inventory snapshot after the mutation.
   */
  @Remote('setEnabled')
  setEnabled(request: PluginEnablementRequest): Promise<PluginInventorySnapshot> {
    return this.enqueue(async () => {
      const resolved = this.ctx.loader.resolve(request.entryId)
      const rootInclude = this.rootInclude()
      const entry = this.representatives(rootInclude).get(resolved.options.name)
      if (entry === undefined || !this.isToggleable(entry, rootInclude)) {
        throw new Error(`pluginInventory: entry ${request.entryId} cannot be toggled in-app`)
      }
      if (request.enabled === this.enabled(entry)) return this.list()

      const states = await this.updateModule(entry, request.enabled)
      try {
        await this.settings.update({ enabled: { [entry.options.name]: request.enabled } })
      } catch (error) {
        try {
          await this.restore(states)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `pluginInventory: failed to persist and roll back ${request.entryId}`)
        }
        throw error
      }
      return this.list()
    })
  }

  /**
   * Fetch every persisted marketplace and report validated metadata only.
   * @returns Catalogs in persisted order; an unavailable source stays visible without details.
   */
  @Remote('listMarketplaces')
  listMarketplaces(): Promise<PluginMarketplaceSnapshot> {
    return this.marketplaceSnapshot()
  }

  /**
   * Validate one catalog before persisting its normalized URL.
   * @param request - marketplace document URL.
   * @returns The refreshed persisted marketplace list.
   */
  @Remote('addMarketplace')
  addMarketplace(request: AddPluginMarketplaceRequest): Promise<PluginMarketplaceSnapshot> {
    return this.enqueue(async () => {
      const loaded = await loadMarketplace(request.source)
      this.profileDir()
      const sources = this.marketplaceSettings.get().sources
      if (!sources.includes(loaded.source)) {
        await this.marketplaceSettings.update({ sources: [...sources, loaded.source] })
      }
      return this.marketplaceSnapshot()
    })
  }

  /**
   * Re-resolve one persisted catalog entry, then install its exact registry package through `bh plugin`.
   * Package lifecycle scripts stay disabled; the new bundle joins the running profile after restart.
   * @param request - persisted marketplace source and marketplace-local plugin id.
   * @returns Refreshed catalogs and whether this call changed the profile stack.
   */
  @Remote('installMarketplacePlugin')
  installMarketplacePlugin(request: InstallMarketplacePluginRequest): Promise<MarketplacePluginInstallResult> {
    return this.enqueue(async () => {
      const source = normalizeMarketplaceSource(request.source)
      const persisted = this.marketplaceSettings.get().sources.includes(source)
      if (!persisted) throw new Error(`pluginInventory: marketplace ${source} is not configured`)
      const loaded = await loadMarketplace(source)
      const plugin = loaded.document.plugins.find(candidate => marketplacePluginId(candidate) === request.pluginId)
      if (plugin === undefined) {
        throw new Error(`pluginInventory: marketplace ${source} has no plugin ${request.pluginId}`)
      }
      const profileDir = this.profileDir()
      if (this.installedBundles(profileDir).has(plugin.package)) {
        return { snapshot: await this.marketplaceSnapshot(), restartRequired: false }
      }
      const manifestPath = join(profileDir, 'package.json')
      const before = await readFile(manifestPath, 'utf8')
      const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
      const beforeLockfile = await readFile(lockfilePath).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      })
      const restoreLockfile = (): Promise<void> => beforeLockfile === undefined
        ? rm(lockfilePath, { force: true })
        : writeFile(lockfilePath, beforeLockfile)
      const packageSpec = `${plugin.package}@${plugin.version}`
      try {
        await runProfilePlugin(
          profileDir,
          ['add', '--save-exact', '--ignore-scripts', packageSpec],
          `failed to install ${packageSpec}`,
        )
        if (!this.installedBundles(profileDir).has(plugin.package)) {
          throw new Error(`pluginInventory: ${packageSpec} declares no installable bh bundle`)
        }
      } catch (error) {
        try {
          await writeFile(manifestPath, before)
          await restoreLockfile()
          try {
            await runProfilePlugin(
              profileDir,
              ['install', '--ignore-scripts'],
              `failed to roll back ${packageSpec}`,
            )
          } finally {
            await writeFile(manifestPath, before)
            await restoreLockfile()
          }
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `pluginInventory: failed to install and roll back ${packageSpec}`)
        }
        throw error
      }
      return { snapshot: await this.marketplaceSnapshot(), restartRequired: true }
    })
  }
}

export default PluginInventoryGateway
