/** Runtime plugin inventory plus shared user-setting enablement controls. */

import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type FiberState } from '@bosch/cordis'
import type { Entry } from '@bosch/cordis-plugin-loader'
import type { Include } from '@bosch/cordis-plugin-include'
import { profilePluginEnablement, readProfileManifest, resolveProfileDir } from '@bosch/bh-app-boot'
import { withFileLock, writeFileAtomic } from '@bosch/bh-atomic-write'
import { settingsNamespace, type SettingsScope } from '@bosch/bh-settings'
import { TypertRemoteService, Remote } from '@bosch/bh-typert-protocol'
import type {
  ImportedPluginEntry, ImportedPluginRuntime, ImportedPluginSnapshot, PluginImportSource,
} from '@bosch/bh-plugin-runtime'
import z from '@bosch/schemastery'
import { z as zod } from 'zod'
import type {
  AddPluginMarketplaceRequest,
  ImportedPluginMcpServerEnablementRequest,
  PluginEnablementRequest,
  PluginEnablementResult,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
  PluginMarketplaceSnapshot,
  PluginMarketplaceView,
  SetPluginMarketplaceEnablementRequest,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
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
const AGENT_PRESET_ENTRY_PREFIX = 'agent-preset:'
const MAX_MARKETPLACE_BYTES = 1024 * 1024
const MARKETPLACE_GIT_TIMEOUT_MS = 30_000
const MAX_MARKETPLACE_SPARSE_PATHS = 20
const MAX_MARKETPLACE_SPARSE_PATH_LENGTH = 512
const GITHUB_SHORTHAND_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u
const MarketplaceDocumentSchema = zod.object({
  plugins: zod.array(zod.record(zod.string(), zod.unknown())).max(500),
}).passthrough()

type MarketplaceDocument = zod.infer<typeof MarketplaceDocumentSchema>

interface PluginSettings {
  enabled: Record<string, boolean>
}

const PluginSettingsSchema: z<PluginSettings> = z.object({
  enabled: z.dict(z.boolean()).default({}),
})

interface MarketplaceSource {
  source: string
  gitRef: string
  sparsePaths: string[]
  enabled: boolean
}

interface MarketplaceSettings {
  sources: MarketplaceSource[]
}

const MarketplaceSourceSchema: z<MarketplaceSource> = z.object({
  source: z.string(),
  gitRef: z.string().default(''),
  sparsePaths: z.array(z.string()).max(MAX_MARKETPLACE_SPARSE_PATHS).default([]),
  enabled: z.boolean().default(true),
})

const MarketplaceSettingsSchema: z<MarketplaceSettings> = z.object({
  sources: z.array(MarketplaceSourceSchema).max(20).default([]),
})

interface LoadedMarketplace {
  source: MarketplaceSource
  document: MarketplaceDocument
}

interface NormalizedMarketplaceSource extends MarketplaceSource {
  kind: 'git' | 'local'
}

function missingPath(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function normalizeGitRef(value: string | undefined): string | undefined {
  const gitRef = value?.trim()
  if (gitRef === undefined || gitRef === '') return undefined
  if (gitRef.length > 255
    || gitRef.startsWith('-')
    || /[\u0000-\u0020\u007F]/u.test(gitRef)) {
    throw new Error('pluginInventory: Git ref is invalid')
  }
  return gitRef
}

function normalizeSparsePaths(values: readonly string[] | undefined): string[] {
  if ((values?.length ?? 0) > MAX_MARKETPLACE_SPARSE_PATHS) {
    throw new Error(`pluginInventory: at most ${String(MAX_MARKETPLACE_SPARSE_PATHS)} sparse paths are allowed`)
  }
  const paths = (values ?? []).map((value) => {
    const path = value.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
    if (path.length > MAX_MARKETPLACE_SPARSE_PATH_LENGTH) {
      throw new Error(`pluginInventory: sparse paths may contain at most ${String(MAX_MARKETPLACE_SPARSE_PATH_LENGTH)} characters`)
    }
    const segments = path.split('/')
    if (path === ''
      || path.startsWith('/')
      || path.startsWith('-')
      || /^[A-Za-z]:\//u.test(path)
      || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`pluginInventory: sparse path ${JSON.stringify(value)} must be repository-relative`)
    }
    return path
  })
  return [...new Set(paths)].sort()
}

function normalizeGitSource(source: string): string {
  const shorthand = GITHUB_SHORTHAND_PATTERN.exec(source)
  if (shorthand !== null) {
    const owner = shorthand[1] ?? ''
    const repository = (shorthand[2] ?? '').replace(/\.git$/u, '')
    return `https://github.com/${owner}/${repository}.git`
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u.test(source)) return source
  let url: URL
  try {
    url = new URL(source)
  } catch (cause) {
    throw new Error('pluginInventory: source must be a GitHub repo, Git URL, or existing local folder', { cause })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    throw new Error('pluginInventory: remote marketplace source must use HTTPS or SSH')
  }
  if (url.password !== '' || url.hash !== '' || url.search !== ''
    || (url.protocol === 'https:' && url.username !== '')) {
    throw new Error('pluginInventory: marketplace source cannot contain credentials, a query, or a fragment')
  }
  return url.href
}

async function normalizeMarketplaceSource(
  request: AddPluginMarketplaceRequest | MarketplaceSource,
): Promise<NormalizedMarketplaceSource> {
  const source = request.source.trim()
  if (source === '' || source.length > 2048 || /[\u0000-\u001F\u007F]/u.test(source)) {
    throw new Error('pluginInventory: marketplace source is invalid')
  }
  const gitRef = normalizeGitRef(request.gitRef)
  const sparsePaths = normalizeSparsePaths(request.sparsePaths)
  const localPath = resolve(source)
  try {
    if (!GITHUB_SHORTHAND_PATTERN.test(source) && (await stat(localPath)).isDirectory()) {
      if (gitRef !== undefined || sparsePaths.length > 0) {
        throw new Error('pluginInventory: Git ref and sparse paths require a Git source')
      }
      return { kind: 'local', source: await realpath(localPath), gitRef: '', sparsePaths: [], enabled: true }
    }
  } catch (error) {
    if (!missingPath(error)) throw error
  }
  return {
    kind: 'git',
    source: normalizeGitSource(source),
    gitRef: gitRef ?? '',
    sparsePaths,
    enabled: true,
  }
}

function marketplaceGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)) env[name] = value
  }
  env.GCM_INTERACTIVE = 'Never'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

function runGit(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [
      '-c', 'protocol.ext.allow=never',
      '-c', 'protocol.file.allow=never',
      ...args,
    ], {
      cwd,
      encoding: 'utf8',
      env: marketplaceGitEnv(),
      maxBuffer: MAX_MARKETPLACE_BYTES,
      timeout: MARKETPLACE_GIT_TIMEOUT_MS,
      windowsHide: true,
    }, (error, _stdout, stderr) => {
      if (error === null) {
        resolvePromise()
        return
      }
      const detail = stderr.trim().split(/\r?\n/u)[0]
      reject(new Error(
        `pluginInventory: failed to load Git marketplace${detail === undefined || detail === '' ? '' : `: ${detail}`}`,
        { cause: error },
      ))
    })
  })
}

async function readMarketplaceDocument(root: string): Promise<MarketplaceDocument> {
  for (const relativePath of ['.agents/plugins/marketplace.json', 'marketplace.json']) {
    const filename = join(root, relativePath)
    try {
      const metadata = await lstat(filename)
      if (!metadata.isFile()) continue
      if (metadata.size > MAX_MARKETPLACE_BYTES) {
        throw new Error(`pluginInventory: marketplace exceeds ${String(MAX_MARKETPLACE_BYTES)} bytes`)
      }
      const body = await readFile(filename)
      if (body.byteLength > MAX_MARKETPLACE_BYTES) {
        throw new Error(`pluginInventory: marketplace exceeds ${String(MAX_MARKETPLACE_BYTES)} bytes`)
      }
      return MarketplaceDocumentSchema.parse(JSON.parse(body.toString('utf8')) as unknown)
    } catch (error) {
      if (missingPath(error)) continue
      throw error
    }
  }
  throw new Error('pluginInventory: OpenAI/Codex marketplace.json is missing')
}

/** Load and validate one marketplace root without retaining an executable checkout. */
async function loadMarketplace(request: AddPluginMarketplaceRequest | MarketplaceSource): Promise<LoadedMarketplace> {
  const normalized = await normalizeMarketplaceSource(request)
  const { kind, ...source } = normalized
  if (kind === 'local') {
    return { source, document: await readMarketplaceDocument(source.source) }
  }

  // ponytail: temporary shallow clones avoid cache invalidation; add snapshots if list latency becomes material.
  const tempRoot = await mkdtemp(join(tmpdir(), 'bh-marketplace-'))
  const checkout = join(tempRoot, 'repository')
  try {
    if (source.gitRef !== '') {
      try {
        await runGit(tempRoot, ['check-ref-format', '--allow-onelevel', source.gitRef])
      } catch (cause) {
        throw new Error('pluginInventory: Git ref is invalid', { cause })
      }
    }
    const cloneArgs = ['clone', '--depth', '1', '--filter=blob:none']
    if (source.sparsePaths.length > 0) cloneArgs.push('--sparse')
    if (source.gitRef !== '') cloneArgs.push('--no-checkout')
    cloneArgs.push('--', source.source, checkout)
    await runGit(tempRoot, cloneArgs)
    if (source.gitRef !== '') {
      await runGit(tempRoot, ['-C', checkout, 'fetch', '--depth', '1', 'origin', source.gitRef])
    }
    if (source.sparsePaths.length > 0) {
      await runGit(tempRoot, [
        '-C', checkout, 'sparse-checkout', 'set', '--cone', '--sparse-index', '--',
        '.agents/plugins', ...source.sparsePaths,
      ])
    }
    if (source.gitRef !== '') {
      await runGit(tempRoot, ['-C', checkout, 'checkout', '--detach', 'FETCH_HEAD'])
    }
    return { source, document: await readMarketplaceDocument(checkout) }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

/** Plugin ids whose desired state applies only when the profile starts again. */
export interface Config {
  /** Direct root entry ids protected from live unload. */
  protectedEntryIds?: string[]
  /** Entry ids owned by another composition plane and omitted from this inventory. */
  compositionEntryIds?: string[]
}

interface EntryState {
  entry: Entry
  disabled: boolean | null | undefined
  config: unknown
}

/** Optional preset service shape; inventory must also run without a roster. */
interface AgentPresetPluginControls {
  listPluginEntries(): Promise<readonly {
    entryId: string
    presetId: string
    moduleName: string
    enabled: boolean
  }[]>
  setPluginEnabled(entryId: string, enabled: boolean): Promise<void>
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
  private restartEnablement: Record<string, boolean> = {}
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
    if ([...representatives.values()].some(entry => this.isRestartOnly(entry))) {
      this.restartEnablement = profilePluginEnablement(
        readProfileManifest('pluginInventory', this.profileDir()),
      )
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

  /** Project persisted OpenAI/Codex marketplace sources without exposing their entries here. */
  private async marketplaceSnapshot(): Promise<PluginMarketplaceSnapshot> {
    const sources = this.marketplaceSettings.get().sources
    if (sources.length === 0) return { marketplaces: [] }
    const marketplaces: PluginMarketplaceView[] = []
    for (const source of sources) {
      const sourceView = {
        source: source.source,
        ...(source.gitRef === '' ? {} : { gitRef: source.gitRef }),
        sparsePaths: source.sparsePaths,
        enabled: source.enabled,
      }
      try {
        await loadMarketplace(source)
        marketplaces.push({ status: 'ready', ...sourceView })
      } catch {
        marketplaces.push({ status: 'unavailable', ...sourceView })
      }
    }
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

  /** Whether changing this root entry must wait for the next profile boot. */
  private isRestartOnly(entry: Entry): boolean {
    return this.protectedEntryIds.has(entry.options.id)
  }

  private isToggleable(entry: Entry, rootInclude = this.rootInclude()): boolean {
    return rootInclude !== undefined
      && entry.parent.tree === rootInclude
  }

  private enabled(entry: Entry): boolean {
    if (this.isRestartOnly(entry) || !this.isToggleable(entry)) return !entry.disabled
    return this.settings.get().enabled[entry.options.name]
      ?? this.defaultEnabled.get(entry.options.name)
      ?? !entry.disabled
  }

  /** Desired state used by the switch; restart-only entries retain the live Loader state until reboot. */
  private desiredEnabled(entry: Entry): boolean {
    return this.isRestartOnly(entry)
      ? this.restartEnablement[entry.options.id] ?? !entry.disabled
      : this.enabled(entry)
  }

  /** Whether the currently loaded entry still differs from its persisted desired state. */
  private restartRequired(entry: Entry): boolean {
    const pending = this.restartEnablement[entry.options.id]
    return this.isRestartOnly(entry) && pending !== undefined && pending !== !entry.disabled
  }

  /** Resolve the active root Include to the profile directory the launcher owns. */
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

  /** Persist one restart-only root switch without changing the live Loader tree. */
  private async setRestartEnabled(entry: Entry, enabled: boolean): Promise<void> {
    const profileDir = this.profileDir()
    const manifestPath = join(profileDir, 'package.json')
    await withFileLock(manifestPath, async () => {
      // Re-read while holding the cross-process lock so a concurrent profile
      // edit cannot be replaced by a stale manifest snapshot.
      const manifest = readProfileManifest('pluginInventory', profileDir)
      const pluginEnablement = {
        ...profilePluginEnablement(manifest),
        [entry.options.id]: enabled,
      }
      const next = {
        ...manifest,
        bh: {
          ...manifest.bh,
          profile: {
            ...manifest.bh?.profile,
            pluginEnablement,
          },
        },
      }
      await writeFileAtomic(manifestPath, `${JSON.stringify(next, undefined, 2)}\n`, { mode: 0o600 })
      this.restartEnablement = pluginEnablement
    })
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
      if (!this.isToggleable(entry, rootInclude) || this.isRestartOnly(entry)) continue
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
   * Read the Loader and optional preset roster directly on every call. Cordis's
   * internal plugin/status events already maintain Entry.fiber and Fiber state,
   * so a second Host cache would only add another lifecycle truth to synchronize.
   * @returns Current Host entries followed by preset-owned leaf entries.
   */
  private hostEntries(): PluginInventoryEntry[] {
    const entries: PluginInventoryEntry[] = []
    const rootInclude = this.rootInclude()
    for (const entry of this.representatives(rootInclude).values()) {
      const enabled = this.enabled(entry)
      const restartRequired = this.restartRequired(entry)
      const pendingEnabled = restartRequired ? this.restartEnablement[entry.options.id] : undefined
      const active = enabled
        ? this.moduleEntries(entry.options.name).find(candidate => !candidate.disabled && candidate.fiber !== undefined)
        : undefined
      const fiber = active?.fiber
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled,
        ...pendingEnabled === undefined ? {} : { pendingEnabled },
        restartRequired,
        toggleable: this.isToggleable(entry, rootInclude),
        fiberPhase: fiber === undefined ? null : FIBER_PHASE[fiber.state],
      })
    }
    return entries
  }

  private async presetEntries(): Promise<PluginInventoryEntry[]> {
    const presets = this.agentPresets()
    if (presets === undefined) return []
    return (await presets.listPluginEntries()).map(entry => ({
      entryId: pluginEntryId(entry.entryId),
      moduleName: entry.moduleName,
      enabled: entry.enabled,
      presetId: entry.presetId,
      newSessionsOnly: true,
      restartRequired: false,
      toggleable: true,
      fiberPhase: null,
    }))
  }

  /**
   * List Host entries and the optional preset-owned leaf entries.
   * @returns the current inventory projection.
   */
  @Remote('list')
  async list(): Promise<PluginInventorySnapshot> {
    return { entries: [...this.hostEntries(), ...(await this.presetEntries())] }
  }

  /**
   * Persist a restart-only root state without live unload, or apply one normal
   * module-wide live state and persist it in the shared settings document.
   * @param request - target entry and desired enablement.
   * @returns The fresh snapshot and whether this mutation needs a restart.
   */
  @Remote('setEnabled')
  setEnabled(request: PluginEnablementRequest): Promise<PluginEnablementResult> {
    return this.enqueue(async () => {
      if (request.entryId.startsWith(AGENT_PRESET_ENTRY_PREFIX)) {
        const presets = this.agentPresets()
        if (presets === undefined) {
          throw new Error('pluginInventory: agent preset controls are unavailable')
        }
        const entry = (await presets.listPluginEntries())
          .find(candidate => candidate.entryId === request.entryId)
        if (entry === undefined) {
          throw new Error(`pluginInventory: preset entry ${request.entryId} cannot be toggled in-app`)
        }
        if (entry.enabled !== request.enabled) {
          await presets.setPluginEnabled(entry.entryId, request.enabled)
        }
        return { snapshot: await this.list(), restartRequired: false }
      }
      const resolved = this.ctx.loader.resolve(request.entryId)
      const rootInclude = this.rootInclude()
      const entry = this.representatives(rootInclude).get(resolved.options.name)
      if (entry === undefined || !this.isToggleable(entry, rootInclude)) {
        throw new Error(`pluginInventory: entry ${request.entryId} cannot be toggled in-app`)
      }
      if (request.enabled === this.desiredEnabled(entry)) {
        return { snapshot: await this.list(), restartRequired: this.restartRequired(entry) }
      }

      if (this.isRestartOnly(entry)) {
        await this.setRestartEnabled(entry, request.enabled)
        return { snapshot: await this.list(), restartRequired: this.restartRequired(entry) }
      }

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
      return { snapshot: await this.list(), restartRequired: false }
    })
  }

  /** @returns OpenAI/Codex marketplace sources in persisted order. */
  @Remote('listMarketplaces')
  listMarketplaces(): Promise<PluginMarketplaceSnapshot> {
    return this.marketplaceSnapshot()
  }

  /** @returns The refreshed OpenAI/Codex marketplace source list. */
  @Remote('addMarketplace')
  addMarketplace(request: AddPluginMarketplaceRequest): Promise<PluginMarketplaceSnapshot> {
    return this.enqueue(async () => {
      const loaded = await loadMarketplace(request)
      const sources = this.marketplaceSettings.get().sources
      const existing = sources.findIndex(source => source.source === loaded.source.source)
      const entry = { ...loaded.source, enabled: sources[existing]?.enabled ?? true }
      const next = existing === -1
        ? [...sources, entry]
        : sources.map((source, index) => index === existing ? entry : source)
      await this.marketplaceSettings.update({ sources: next })
      return this.marketplaceSnapshot()
    })
  }

  /** Enable or disable one marketplace slot, cascading to its imported plugins. */
  @Remote('setMarketplaceEnabled')
  setMarketplaceEnabled(request: SetPluginMarketplaceEnablementRequest): Promise<PluginMarketplaceSnapshot> {
    return this.enqueue(async () => {
      const sources = this.marketplaceSettings.get().sources
      const index = sources.findIndex(candidate => candidate.source === request.source)
      if (index === -1) throw new Error(`pluginInventory: marketplace ${request.source} is not configured`)
      const next = sources.map((candidate, position) => position === index
        ? { ...candidate, enabled: request.enabled }
        : candidate)
      await this.marketplaceSettings.update({ sources: next })
      await this.cascadeMarketplacePlugins(
        request.source,
        (runtime, identity) => request.enabled ? runtime.enable(identity) : runtime.disable(identity),
      )
      return this.marketplaceSnapshot()
    })
  }

  /** Remove one persisted OpenAI/Codex marketplace source and uninstall its imported plugins. */
  @Remote('removeMarketplace')
  removeMarketplace(source: string): Promise<PluginMarketplaceSnapshot> {
    return this.enqueue(async () => {
      if (!this.marketplaceSettings.get().sources.some(candidate => candidate.source === source)) {
        throw new Error(`pluginInventory: marketplace ${source} is not configured`)
      }
      await this.cascadeMarketplacePlugins(source, (runtime, identity) => runtime.remove(identity))
      const next = this.marketplaceSettings.get().sources.filter(candidate => candidate.source !== source)
      await this.marketplaceSettings.update({ sources: next })
      return await this.marketplaceSnapshot()
    })
  }

  /**
   * Apply one lifecycle action to every plugin imported from this marketplace root.
   * A no-op when the imported-plugin runtime is not part of this composition.
   */
  private async cascadeMarketplacePlugins(
    marketplace: string,
    action: (runtime: ImportedPluginRuntime, identity: string) => Promise<ImportedPluginSnapshot>,
  ): Promise<void> {
    const runtime = this.ctx.get('importedPlugins')
    if (runtime === undefined) return
    const plugins = (await runtime.list()).plugins.filter(plugin => plugin.source.marketplace === marketplace)
    const failures: unknown[] = []
    for (const plugin of plugins) {
      try {
        await action(runtime, plugin.identity)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, `pluginInventory: failed to update plugins for marketplace ${marketplace}`)
    }
  }

  /**
   * List source-qualified imported OpenAI/Codex plugin bundles.
   * @returns Current imported-plugin projection.
   */
  @Remote('listImportedPlugins')
  listImportedPlugins(): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().list()
  }

  /**
   * Stage a direct local/Git source or marketplace bundle through the shared runtime.
   * @param source - Plugin source to import.
   * @returns Current imported-plugin projection.
   */
  @Remote('importPlugin')
  importPlugin(source: PluginImportSource): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().import(source)
  }

  /**
   * Read one imported bundle by source-qualified identity or an unambiguous name.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current plugin projection.
   */
  @Remote('infoPlugin')
  infoPlugin(identityOrName: string): Promise<ImportedPluginEntry> {
    return this.importedPlugins().info(identityOrName)
  }

  /**
   * Enable and load one imported bundle without changing native BH package state.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('enablePlugin')
  enablePlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().enable(identityOrName)
  }

  /**
   * Disable and deterministically unload one imported bundle.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('disablePlugin')
  disablePlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().disable(identityOrName)
  }

  /** Change one imported plugin MCP server without changing hook trust. */
  @Remote('setPluginMcpServerEnabled')
  setPluginMcpServerEnabled(
    request: ImportedPluginMcpServerEnablementRequest,
  ): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().setMcpServerEnabled(request.identity, request.server, request.enabled)
  }

  /**
   * Trust only the current hook definitions; MCP/tool approval remains independent.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('trustPlugin')
  trustPlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().trustHooks(identityOrName)
  }

  /**
   * Revoke hook trust without disabling other plugin components.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('untrustPlugin')
  untrustPlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().untrustHooks(identityOrName)
  }

  /**
   * Remove one imported bundle and its writable plugin data.
   * @param identityOrName - Source-qualified identity or unambiguous plugin name.
   * @returns Current imported-plugin projection.
   */
  @Remote('removePlugin')
  removePlugin(identityOrName: string): Promise<ImportedPluginSnapshot> {
    return this.importedPlugins().remove(identityOrName)
  }

  private importedPlugins(): ImportedPluginRuntime {
    const runtime = this.ctx.get('importedPlugins') as ImportedPluginRuntime | undefined
    if (runtime === undefined) throw new Error('pluginInventory: imported plugin runtime is unavailable')
    return runtime
  }

  /** Agent-preset ownership is optional in headless and non-roster compositions. */
  private agentPresets(): AgentPresetPluginControls | undefined {
    return this.ctx.get('agentPresets') as AgentPresetPluginControls | undefined
  }
}

export default PluginInventoryGateway
