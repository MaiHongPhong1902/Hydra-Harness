// @vitest-environment jsdom
import { Context, Service } from '@bosch/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@bosch/bh-client-locale/client'
import { SlotRegistry } from '@bosch/bh-client-runtime/client'
import { resolveSlotLabel } from '@bosch/bh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@bosch/bh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { MarketplaceSettingsTab } from '../src/client/MarketplaceSettingsTab.tsx'
import type { MarketplaceSettingsTabInjected } from '../src/client/MarketplaceSettingsTab.tsx'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type { PluginInventorySettingsTabInjected } from '../src/client/PluginInventorySettingsTab.tsx'

usePinnedBrowserLanguages('en-US')
afterEach(cleanup)

const EMPTY = { entries: [] }
const EMPTY_MARKETPLACES = { marketplaces: [] }
const EMPTY_INSTALL = { snapshot: EMPTY_MARKETPLACES, restartRequired: false }
type ListResult =
  | { readonly ok: true; readonly value: typeof EMPTY }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
type MarketplaceResult =
  | { readonly ok: true; readonly value: typeof EMPTY_MARKETPLACES }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
type InstallResult =
  | { readonly ok: true; readonly value: typeof EMPTY_INSTALL }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench(isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const list = vi.fn<() => Promise<ListResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  const setEnabled = vi.fn<() => Promise<ListResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  const listMarketplaces = vi.fn<() => Promise<MarketplaceResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY_MARKETPLACES })
  const addMarketplace = vi.fn<() => Promise<MarketplaceResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY_MARKETPLACES })
  const installMarketplacePlugin = vi.fn<() => Promise<InstallResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY_INSTALL })
  ctx.provide('connection', { isLoopback, api: {} } as never)
  ctx.provide('remote.pluginInventory', {
    list,
    setEnabled,
    listMarketplaces,
    addMarketplace,
    installMarketplacePlugin,
  })
  return {
    ctx,
    slots: ctx.get('slots') as SlotRegistry,
    locale,
    list,
    setEnabled,
    listMarketplaces,
    addMarketplace,
    installMarketplacePlugin,
  }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugin-inventory browser plugin', () => {
  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.pluginInventory'])
  })

  it('registers localized tabs without reading the Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entries = b.slots.entries('settings.plugins.tab')
    expect(entries).toHaveLength(2)
    const entry = entries.find(entry => entry.options.id === 'all')!
    expect(entry.component).toBe(PluginInventorySettingsTab)
    expect(entry.options).toMatchObject({ id: 'all', order: 10 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('Plugin list')
    expect(b.list).not.toHaveBeenCalled()

    const marketplaceEntry = entries.find(entry => entry.options.id === 'marketplace')!
    expect(marketplaceEntry.component).toBe(MarketplaceSettingsTab)
    expect(marketplaceEntry.options).toMatchObject({ id: 'marketplace', order: 20 })
    expect(marketplaceEntry.locale).toBe(NS)
    expect(resolveSlotLabel(marketplaceEntry.options.label)).toBe('Marketplace')
    expect(b.listMarketplaces).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => PluginInventorySettingsTabInjected)()
    await expect(injected.list()).resolves.toEqual(EMPTY)
    expect(b.list).toHaveBeenCalledOnce()
    await expect(injected.setEnabled('entry' as never, false)).resolves.toEqual(EMPTY)
    expect(b.setEnabled).toHaveBeenCalledWith({ entryId: 'entry', enabled: false })
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.list()).rejects.toThrow('pluginInventory.list failed: REMOTE_ERROR: unavailable')
    b.setEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.setEnabled('entry' as never, true))
      .rejects.toThrow('pluginInventory.setEnabled failed: REMOTE_ERROR: unavailable')

    const marketplaceInjected = (
      marketplaceEntry.inject as unknown as () => MarketplaceSettingsTabInjected
    )()
    await expect(marketplaceInjected.listMarketplaces()).resolves.toEqual(EMPTY_MARKETPLACES)
    expect(b.listMarketplaces).toHaveBeenCalledOnce()
    await expect(marketplaceInjected.addMarketplace('https://example.test/marketplace.json'))
      .resolves.toEqual(EMPTY_MARKETPLACES)
    expect(b.addMarketplace).toHaveBeenCalledWith({ source: 'https://example.test/marketplace.json' })
    await expect(marketplaceInjected.installMarketplacePlugin(
      'https://example.test/marketplace.json',
      'example-plugin' as never,
    )).resolves.toEqual(EMPTY_INSTALL)
    expect(b.installMarketplacePlugin).toHaveBeenCalledWith({
      source: 'https://example.test/marketplace.json',
      pluginId: 'example-plugin',
    })
    b.listMarketplaces.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(marketplaceInjected.listMarketplaces())
      .rejects.toThrow('pluginInventory.listMarketplaces failed: REMOTE_ERROR: unavailable')
    b.addMarketplace.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(marketplaceInjected.addMarketplace('https://example.test/marketplace.json'))
      .rejects.toThrow('pluginInventory.addMarketplace failed: REMOTE_ERROR: unavailable')
    b.installMarketplacePlugin.mockResolvedValueOnce({
      ok: false,
      error: { code: 'REMOTE_ERROR', message: 'unavailable' },
    })
    await expect(marketplaceInjected.installMarketplacePlugin(
      'https://example.test/marketplace.json',
      'example-plugin' as never,
    )).rejects.toThrow('pluginInventory.installMarketplacePlugin failed: REMOTE_ERROR: unavailable')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench(false)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    expect(b.slots.entries('settings.plugins.tab')[0]?.options.id).toBe('all')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Plugin list')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.plugins.tab')[0]?.component).toBe(PluginInventorySettingsTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'en', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
