/** Host plugin inventory and enablement controls registered into Web Settings. */

import type {} from '@bosch/bh-client-locale/client'
import type { ClientContext } from '@bosch/bh-client-runtime/client'
import type { ConnectionHandle } from '@bosch/bh-client-connection/client'
import type {} from '@bosch/bh-client-ui-settings/client'
import { MarketplaceSettingsTab, type MarketplaceSettingsTabInjected } from './MarketplaceSettingsTab.tsx'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from './locales.ts'

export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type { MarketplaceSettingsTabInjected, MarketplaceSettingsTabProps } from './MarketplaceSettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@bosch/bh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Host plugin inventory copy and mutation labels. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.pluginInventory']

/** Contribute the lazy inventory tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  const list: PluginInventorySettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const setEnabled: PluginInventorySettingsTabInjected['setEnabled'] = async (entryId, enabled) => {
    const result = await ctx.remote.pluginInventory.setEnabled({ entryId, enabled })
    if (!result.ok) {
      throw new Error(`pluginInventory.setEnabled failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const injected = (): PluginInventorySettingsTabInjected => ({ list, setEnabled })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInventorySettingsTab))

  if (connection.isLoopback) {
    const listMarketplaces: MarketplaceSettingsTabInjected['listMarketplaces'] = async () => {
      const result = await ctx.remote.pluginInventory.listMarketplaces()
      if (!result.ok) {
        throw new Error(`pluginInventory.listMarketplaces failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    }
    const addMarketplace: MarketplaceSettingsTabInjected['addMarketplace'] = async (source) => {
      const result = await ctx.remote.pluginInventory.addMarketplace({ source })
      if (!result.ok) {
        throw new Error(`pluginInventory.addMarketplace failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    }
    const installMarketplacePlugin: MarketplaceSettingsTabInjected['installMarketplacePlugin'] = async (
      source,
      pluginId,
    ) => {
      const result = await ctx.remote.pluginInventory.installMarketplacePlugin({ source, pluginId })
      if (!result.ok) {
        throw new Error(
          `pluginInventory.installMarketplacePlugin failed: ${result.error.code}: ${result.error.message}`,
        )
      }
      return result.value
    }
    const marketplaceInjected = (): MarketplaceSettingsTabInjected => ({
      addMarketplace,
      installMarketplacePlugin,
      listMarketplaces,
    })
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'marketplace',
      order: 20,
      label: () => t('marketplaceTab'),
      locale: NS,
      inject: marketplaceInjected,
    }, MarketplaceSettingsTab))
  }
}
