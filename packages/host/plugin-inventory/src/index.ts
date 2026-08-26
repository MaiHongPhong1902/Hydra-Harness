/** Runtime plugin inventory plus shared user-setting enablement controls. */

import { Service, type Context, type FiberState } from '@bosch/cordis'
import type { Entry } from '@bosch/cordis-plugin-loader'
import type { Include } from '@bosch/cordis-plugin-include'
import { settingsNamespace, type SettingsScope } from '@bosch/bh-settings'
import { TypertRemoteService, Remote } from '@bosch/bh-typert-protocol'
import z from '@bosch/schemastery'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  PluginEnablementRequest,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
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
const HMR_MODULE = '@bosch/cordis-plugin-hmr'

interface PluginSettings {
  enabled: Record<string, boolean>
}

const PluginSettingsSchema: z<PluginSettings> = z.object({
  enabled: z.dict(z.boolean()).default({}),
})

/** Plugin ids whose removal would strand the in-app control path. */
export interface Config {
  /** Direct root entry ids that must stay enabled to preserve the control path. */
  protectedEntryIds?: string[]
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
  })

  private readonly protectedEntryIds: ReadonlySet<string>
  private readonly settings: SettingsScope<PluginSettings>
  private readonly defaultEnabled = new Map<string, boolean>()
  private readonly originalConfigs = new Map<string, unknown>()
  private readonly appliedSettings = new Set<string>()
  private mutationTail: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'pluginInventory')
    this.protectedEntryIds = new Set(config.protectedEntryIds)
    this.settings = ctx.settings.register(PLUGIN_SETTINGS_NAMESPACE, PluginSettingsSchema)
  }

  protected async [Service.init](): Promise<void> {
    const rootInclude = this.rootInclude()
    if (rootInclude === undefined) return
    for (const entry of this.representatives(rootInclude).values()) {
      this.defaultEnabled.set(entry.options.name, !entry.disabled && !this.isHmrWatchOnly(entry))
      this.originalConfigs.set(entry.options.name, structuredClone(entry.options.config))
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

  private moduleEntries(moduleName: string): Entry[] {
    const entries: Entry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (!entry.options.group && entry.options.name === moduleName) entries.push(entry)
    }
    return entries
  }

  /** One logical row per module, preferring the profile-owned entry. */
  private representatives(rootInclude: Include | undefined): Map<string, Entry> {
    const entries = new Map<string, Entry>()
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
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
}

export default PluginInventoryGateway
