/** What the browser half registers, and that it all leaves with the fiber. */

import { Context } from '@bosch/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@bosch/bh-client-ui-slots'
import { SlotRegistry } from '@bosch/bh-client-runtime/client'
import { LocaleRuntime } from '@bosch/bh-client-locale/client'
import { TestRemote } from '@bosch/bh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@bosch/bh-client-ui-settings/client'
import { apply, inject } from '@bosch/bh-client-ui-settings-plugins/client'
import type {
  ConfigurablePluginsTabFace, PluginsSettingsSectionInjected,
} from '@bosch/bh-client-ui-settings-plugins/client'

/**
 * @param served - namespaces the Host describes; omitted answers a failed read,
 * which is what most of these specs want (no card has anything to render).
 */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const describeCredentials = vi.fn(() => Promise.resolve({ rpcId: 'c', result: { ok: false, error: {} } }))
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { rpcId: 's', result: { ok: false, error: {} } }
    : {
      rpcId: 's',
      result: {
        ok: true,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: served.map(ns => ({
            ns, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0,
          })),
        },
      },
    }))
  // The section binds its scopes through the Settings surface's service, and
  // forwarded Host events reach it through the same `$dispatch` handoff the
  // connection sink makes.
  new TestRemote(ctx)
  ctx.provide('connection', {
    isLoopback: true,
    api: {
      settings: { describe: describeSettings },
      credentials: { describe: describeCredentials },
    },
  } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeCredentials, describeSettings }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugins apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
  })

  it('registers one Plugins section and declares the tab and card slots', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    expect(section.options).toMatchObject({ id: 'plugins', order: 15 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('Plugins')
    expect(slots.spec('settings.plugins.tab')).toMatchObject({ kind: 'list', scope: 'root' })
    const tabs = slots.entries('settings.plugins.tab')
    expect(tabs[0]?.options).toMatchObject({ id: 'configurable', order: 0 })
    expect(resolveSlotLabel(tabs[0]!.options.label)).toBe('Plugin configuration')
    expect(tabs[1]?.options).toMatchObject({ id: 'mcp', order: 5 })
    expect(resolveSlotLabel(tabs[1]!.options.label)).toBe('MCP')
    expect(slots.spec('settings.plugin.item')).toMatchObject({ kind: 'keyed', scope: 'root' })
  })


  it('injects a live tab projection, the card directory, and one business face per card', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    const sectionFace = (section.inject as unknown as () => PluginsSettingsSectionInjected)()
    const initialTabs = sectionFace.hooks.tabs.getSnapshot()
    expect(initialTabs).toEqual([
      { id: 'configurable', order: 0, label: 'Plugin configuration' },
      { id: 'mcp', order: 5, label: 'MCP' },
    ])
    expect(sectionFace.hooks.tabs.getSnapshot()).toBe(initialTabs)

    const listener = vi.fn()
    const unsubscribe = sectionFace.hooks.tabs.subscribe(listener)
    slots.register({ name: 'settings.plugins.tab', id: 'plain', order: 30 } as never, () => null)
    expect(sectionFace.hooks.tabs.getSnapshot()).toEqual([
      { id: 'configurable', order: 0, label: 'Plugin configuration' },
      { id: 'mcp', order: 5, label: 'MCP' },
      { id: 'plain', order: 30, label: '' },
    ])
    unsubscribe()

    const tab = slots.entries('settings.plugins.tab')[0]!
    const tabFace = (tab.inject as unknown as () => ConfigurablePluginsTabFace)()
    expect(Object.keys(tabFace.hooks)).toEqual(['configurablePlugins'])
    for (const entry of slots.entries('settings.plugin.item')) {
      const face = (entry as { inject?: () => unknown }).inject?.() as { hooks: Record<string, unknown> }
      // Each card injects exactly one snapshot store plus its own actions.
      expect(Object.keys(face.hooks)).toHaveLength(1)
    }
  })

  it('keys each card it ships on the settings namespace that card edits', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('settings.plugin.item').map(entry => entry.options.key))
      .toEqual(['shell', 'agent-loop', 'web-search-deepseek'])
  })

  it('dispatches the served namespaces its cards claim, and no others', async () => {
    // ui-theme is served but belongs to another surface, and a deployment
    // composing no PowerShell/POSIX executor serves no `bash` at all.
    const { ctx, slots } = await bench(['agent-loop', 'ui-theme', 'web-search-deepseek'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const tab = slots.entries('settings.plugins.tab')[0]!
    const face = (tab.inject as unknown as () => ConfigurablePluginsTabFace)()
    await vi.waitFor(() => {
      expect(face.hooks.configurablePlugins.getSnapshot().namespaces)
        .toEqual(['agent-loop', 'web-search-deepseek'])
    })
  })

  it('re-reads the served namespaces when the Host commits a settings document', async () => {
    // Which namespaces the Host serves is a registration fact the wire never
    // announces on its own, so the tab rides the invalidation that can
    // accompany a changed composition.
    const { ctx, slots, describeSettings } = await bench(['bash'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    describeSettings.mockClear()

    ctx.remote.$dispatch('settings/document-updated', ['bash', 1])

    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
  })

  it('re-reads the served namespaces after a reconnect', async () => {
    const { ctx, slots, describeSettings } = await bench(['bash'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    describeSettings.mockClear()

    ctx.emit('connection/reset')

    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
  })

  it('re-reads the credential when the Host reports the watched reference changed', async () => {
    const { ctx, slots, describeCredentials } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    // A key written on another surface changes no settings section, so this
    // event is the only thing that reaches the card.
    ctx.remote.$dispatch('credentials/reference-updated', ['DEEPSEEK_API_KEY'])

    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalledTimes(1) })
  })

  it('re-reads the Obsidian credential from the MCP tab', async () => {
    const { ctx, slots, describeCredentials } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    ctx.remote.$dispatch('credentials/reference-updated', ['OBSIDIAN_API_KEY'])

    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalledTimes(1) })
  })

  it('ignores a credential change for a reference no card watches', async () => {
    const { ctx, slots, describeCredentials } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    ctx.remote.$dispatch('credentials/reference-updated', ['SOME_OTHER_KEY'])
    await Promise.resolve()

    expect(describeCredentials).not.toHaveBeenCalled()
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('collapses every contribution on teardown', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.plugin.item')).toHaveLength(3)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.spec('settings.plugins.tab')).toBeUndefined()
    expect(slots.spec('settings.plugin.item')).toBeUndefined()
  })
})
