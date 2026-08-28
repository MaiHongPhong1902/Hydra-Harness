import type { Branded } from '@bosch/bh-brand'

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Marketplace-local identity of one installable plugin. */
export type MarketplacePluginId = Branded<'MarketplacePluginId'>

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  /** Whether this app can persistently change the entry's enablement. */
  readonly toggleable: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Requested persistent enablement for one Loader entry. */
export interface PluginEnablementRequest {
  readonly entryId: PluginEntryId
  readonly enabled: boolean
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
}

/** Persist one HTTPS or loopback marketplace document URL. */
export interface AddPluginMarketplaceRequest {
  readonly source: string
}

/** Install one catalog entry after the Host resolves its package and exact version. */
export interface InstallMarketplacePluginRequest {
  readonly source: string
  readonly pluginId: MarketplacePluginId
}

/** One validated marketplace plugin projected to trusted browser clients. */
export interface MarketplacePluginView {
  readonly id: MarketplacePluginId
  readonly name: string
  readonly description: string
  readonly packageName: string
  readonly version: string
  readonly installed: boolean
}

/** One persisted marketplace and its latest Host-side fetch result. */
export type PluginMarketplaceView =
  | {
    readonly status: 'ready'
    readonly source: string
    readonly name: string
    readonly plugins: readonly MarketplacePluginView[]
  }
  | {
    readonly status: 'unavailable'
    readonly source: string
  }

/** Point-in-time marketplace catalog returned by the plugin inventory Remote. */
export interface PluginMarketplaceSnapshot {
  readonly marketplaces: readonly PluginMarketplaceView[]
}

/** Marketplace installation result; a newly added bundle joins the profile after restart. */
export interface MarketplacePluginInstallResult {
  readonly snapshot: PluginMarketplaceSnapshot
  readonly restartRequired: boolean
}
