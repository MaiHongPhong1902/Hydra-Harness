/** Host plugin inventory and enablement controls registered into Web Settings. */

import type {} from '@bosch/bh-client-locale/client'
import type { ClientContext } from '@bosch/bh-client-runtime/client'
import type { ConnectionHandle } from '@bosch/bh-client-connection/client'
import type {} from '@bosch/bh-client-ui-settings/client'
import { MarketplaceSettingsTab, type MarketplaceSettingsTabInjected } from './MarketplaceSettingsTab.tsx'
import { ImportedPluginCapabilitiesTab, type ImportedPluginCapabilitiesTabInjected } from './ImportedPluginCapabilitiesTab.tsx'
import {
  PluginInventorySettingsTab,
  type ImportedPluginControls,
  type NativePluginControls,
} from './PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from './locales.ts'

export type {
  ImportedPluginControls,
  NativePluginControls,
  PluginInventorySettingsTabProps,
} from './PluginInventorySettingsTab.tsx'
export type { ImportedPluginCapabilitiesTabInjected, ImportedPluginCapabilitiesTabProps } from './ImportedPluginCapabilitiesTab.tsx'
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

/** Contribute the lazy plugin and marketplace tabs to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  let nativePlugins: NativePluginControls | undefined
  let importedPluginsControls: ImportedPluginControls | undefined
  if (connection.isLoopback) {
    const listPlugins: NativePluginControls['list'] = async () => {
      const result = await ctx.remote.pluginInventory.list()
      if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const setPluginEnabled: NativePluginControls['setEnabled'] = async (entryId, enabled) => {
      const result = await ctx.remote.pluginInventory.setEnabled({ entryId, enabled })
      if (!result.ok) throw new Error(`pluginInventory.setEnabled failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const listMarketplaces: MarketplaceSettingsTabInjected['listMarketplaces'] = async () => {
      const result = await ctx.remote.pluginInventory.listMarketplaces()
      if (!result.ok) {
        throw new Error(`pluginInventory.listMarketplaces failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    }
    const addMarketplace: MarketplaceSettingsTabInjected['addMarketplace'] = async (request) => {
      const result = await ctx.remote.pluginInventory.addMarketplace(request)
      if (!result.ok) {
        throw new Error(`pluginInventory.addMarketplace failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    }
    const removeMarketplace: MarketplaceSettingsTabInjected['removeMarketplace'] = async (source) => {
      const result = await ctx.remote.pluginInventory.removeMarketplace(source)
      if (!result.ok) throw new Error(`pluginInventory.removeMarketplace failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const setMarketplaceEnabled: MarketplaceSettingsTabInjected['setMarketplaceEnabled'] = async (request) => {
      const result = await ctx.remote.pluginInventory.setMarketplaceEnabled(request)
      if (!result.ok) {
        throw new Error(`pluginInventory.setMarketplaceEnabled failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    }
    const listImportedPlugins: ImportedPluginControls['list'] = async () => {
      const result = await ctx.remote.pluginInventory.listImportedPlugins()
      if (!result.ok) throw new Error(`pluginInventory.listImportedPlugins failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const importPlugin: ImportedPluginControls['import'] = async (source) => {
      const result = await ctx.remote.pluginInventory.importPlugin(source)
      if (!result.ok) throw new Error(`pluginInventory.importPlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const enablePlugin: ImportedPluginControls['enable'] = async (identity) => {
      const result = await ctx.remote.pluginInventory.enablePlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.enablePlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const disablePlugin: ImportedPluginControls['disable'] = async (identity) => {
      const result = await ctx.remote.pluginInventory.disablePlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.disablePlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const trustPlugin: NonNullable<ImportedPluginCapabilitiesTabInjected['trust']> = async (identity) => {
      const result = await ctx.remote.pluginInventory.trustPlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.trustPlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const untrustPlugin: NonNullable<ImportedPluginCapabilitiesTabInjected['untrust']> = async (identity) => {
      const result = await ctx.remote.pluginInventory.untrustPlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.untrustPlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const removePlugin: ImportedPluginControls['remove'] = async (identity) => {
      const result = await ctx.remote.pluginInventory.removePlugin(identity)
      if (!result.ok) throw new Error(`pluginInventory.removePlugin failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    nativePlugins = { list: listPlugins, setEnabled: setPluginEnabled }
    const importedPlugins: ImportedPluginControls = {
      list: listImportedPlugins,
      import: importPlugin,
      enable: enablePlugin,
      disable: disablePlugin,
      remove: removePlugin,
    }
    importedPluginsControls = importedPlugins
    const marketplaceInjected = (): MarketplaceSettingsTabInjected => ({
      addMarketplace,
      importedPlugins,
      listMarketplaces,
      removeMarketplace,
      setMarketplaceEnabled,
    })
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'marketplace',
      order: 20,
      label: () => t('marketplaceTab'),
      locale: NS,
      inject: marketplaceInjected,
    }, MarketplaceSettingsTab))
    const capabilitiesInjected = (capability: ImportedPluginCapabilitiesTabInjected['capability']): ImportedPluginCapabilitiesTabInjected => ({
      capability,
      list: listImportedPlugins,
      trust: trustPlugin,
      untrust: untrustPlugin,
    })
    ctx.slots.inject('settings.plugins.tab', function* () {
      yield ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'skills',
        order: 15,
        label: () => t('skillsTab'),
        locale: NS,
        inject: () => capabilitiesInjected('skills'),
      }, ImportedPluginCapabilitiesTab)
      yield ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'hooks',
        order: 25,
        label: () => t('hooksTab'),
        locale: NS,
        inject: () => capabilitiesInjected('hooks'),
      }, ImportedPluginCapabilitiesTab)
    })
  }

  const injected = () => ({
    ...(nativePlugins === undefined ? {} : { nativePlugins }),
    ...(importedPluginsControls === undefined ? {} : { importedPlugins: importedPluginsControls }),
  })
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInventorySettingsTab))
}
