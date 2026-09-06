// @vitest-environment jsdom
import { Context, Service } from '@hydra/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@hydra/harness-client-locale/client'
import { SlotRegistry } from '@hydra/harness-client-runtime/client'
import { resolveSlotLabel } from '@hydra/harness-client-ui-slots'
import { usePinnedBrowserLanguages } from '@hydra/harness-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { ImportedPluginCapabilitiesTab } from '../src/client/ImportedPluginCapabilitiesTab.tsx'
import { MarketplaceSettingsTab } from '../src/client/MarketplaceSettingsTab.tsx'
import type { MarketplaceSettingsTabInjected } from '../src/client/MarketplaceSettingsTab.tsx'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type { PluginInventorySettingsTabInjected } from '../src/client/PluginInventorySettingsTab.tsx'

usePinnedBrowserLanguages('en-US')
afterEach(cleanup)

const EMPTY_MARKETPLACES = { marketplaces: [] }
const EMPTY_IMPORTED = { plugins: [] }
const EMPTY_NATIVE = { entries: [] }
type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench(isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service { constructor(serviceCtx: Context) { super(serviceCtx, 'remote') } }
  new RemoteService(ctx)
  const list = vi.fn<() => Promise<Result<typeof EMPTY_NATIVE>>>().mockResolvedValue({ ok: true, value: EMPTY_NATIVE })
  const setEnabled = vi.fn<() => Promise<Result<typeof EMPTY_NATIVE>>>().mockResolvedValue({ ok: true, value: EMPTY_NATIVE })
  const listMarketplaces = vi.fn<() => Promise<Result<typeof EMPTY_MARKETPLACES>>>()
    .mockResolvedValue({ ok: true, value: EMPTY_MARKETPLACES })
  const addMarketplace = vi.fn<() => Promise<Result<typeof EMPTY_MARKETPLACES>>>()
    .mockResolvedValue({ ok: true, value: EMPTY_MARKETPLACES })
  const removeMarketplace = vi.fn<() => Promise<Result<typeof EMPTY_MARKETPLACES>>>()
    .mockResolvedValue({ ok: true, value: EMPTY_MARKETPLACES })
  const listImportedPlugins = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const importPlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const enablePlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const disablePlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const trustPlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const untrustPlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  const removePlugin = vi.fn<() => Promise<Result<typeof EMPTY_IMPORTED>>>().mockResolvedValue({ ok: true, value: EMPTY_IMPORTED })
  ctx.provide('connection', { isLoopback, api: {} } as never)
  ctx.provide('remote.pluginInventory', { list, setEnabled, listMarketplaces, addMarketplace, removeMarketplace, listImportedPlugins, importPlugin, enablePlugin, disablePlugin, trustPlugin, untrustPlugin, removePlugin })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, setEnabled, listMarketplaces, addMarketplace, removeMarketplace, listImportedPlugins, importPlugin, enablePlugin }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({ name: 'root', children: {
    'settings.plugins.tab': { kind: 'list', scope: 'root' },
    // The real owner of this key is the Hooks tab in ui-settings-plugins; the
    // root stub declares it so this package's contribution has a seat.
    'settings.plugins.hooks.item': { kind: 'list', scope: 'root' },
  } } as never, () => null)
}

describe('ui-settings-plugin-inventory browser plugin', () => {
  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.pluginInventory'])
  })

  it('registers separate Plugins, Skills, and Marketplace tabs plus the Hooks child catalog', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entries = b.slots.entries('settings.plugins.tab')
    expect(entries.map(entry => entry.options.id)).toEqual(['all', 'skills', 'marketplace'])
    expect(entries.find(entry => entry.options.id === 'all')?.component).toBe(PluginInventorySettingsTab)
    expect(entries.find(entry => entry.options.id === 'skills')?.component).toBe(ImportedPluginCapabilitiesTab)
    const marketplace = entries.find(entry => entry.options.id === 'marketplace')
    expect(marketplace?.component).toBe(MarketplaceSettingsTab)
    expect(resolveSlotLabel(entries[0]?.options.label)).toBe('Plugins')

    // The imported hooks catalog contributes to the Hooks tab's child slot.
    const hookItems = b.slots.entries('settings.plugins.hooks.item')
    expect(hookItems.map(entry => entry.options.id)).toEqual(['imported-hooks'])
    expect(hookItems[0]?.component).toBe(ImportedPluginCapabilitiesTab)

    const plugins = (entries.find(entry => entry.options.id === 'all')?.inject as unknown as () => PluginInventorySettingsTabInjected)()
    if (plugins.nativePlugins === undefined) throw new Error('expected local native plugin controls')
    await expect(plugins.nativePlugins.list()).resolves.toEqual(EMPTY_NATIVE)
    expect(b.list).toHaveBeenCalledOnce()
    if (plugins.importedPlugins === undefined) throw new Error('expected local imported plugin controls')
    await expect(plugins.importedPlugins.list()).resolves.toEqual(EMPTY_IMPORTED)
    expect(b.listImportedPlugins).toHaveBeenCalledOnce()

    const marketplaceInjected = marketplace?.inject as unknown as () => MarketplaceSettingsTabInjected
    const marketplaceControls = marketplaceInjected()
    await expect(marketplaceControls.importedPlugins.import('https://github.com/example/plugin.git')).resolves.toEqual(EMPTY_IMPORTED)
    expect(b.importPlugin).toHaveBeenCalledWith('https://github.com/example/plugin.git')
    await expect(marketplaceControls.removeMarketplace('https://github.com/example/plugins.git')).resolves.toEqual(EMPTY_MARKETPLACES)
    expect(b.removeMarketplace).toHaveBeenCalledWith('https://github.com/example/plugins.git')
    await b.ctx.fiber.dispose()
  })

  it('does not expose local marketplace or plugin controls over a remote connection', async () => {
    const b = await bench(false)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    expect(b.slots.entries('settings.plugins.tab')[0]?.options.id).toBe('all')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]?.options.label)).toBe('Plugins')
    stop()
    await fiber.dispose()
    await b.ctx.fiber.dispose()
  })
})
