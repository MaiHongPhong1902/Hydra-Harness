// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportedPluginCapabilitiesTab, type ImportedPluginCapabilitiesTabProps } from '../src/client/ImportedPluginCapabilitiesTab.tsx'
import {
  PluginInventorySettingsTab,
  type NativePluginControls,
  type PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginInventoryLocaleKey): string => en[key]) as PluginInventorySettingsTabProps['t']
const SNAPSHOT = {
  plugins: [{
    identity: 'ponytail@local' as never,
    name: 'Ponytail',
    version: '4.9.0',
    source: { kind: 'local' as const, source: 'C:\\plugins\\ponytail', sourceId: 'local' },
    pluginRoot: 'C:\\plugins\\ponytail',
    dataPath: 'C:\\data\\ponytail',
    enabled: false,
    lifecycle: 'installed' as const,
    hookTrustState: 'pending' as const,
    skills: ['ponytail', 'ponytail-help'],
    mcpServers: [],
    hooks: ['PreToolUse'],
    installationStatus: 'installed' as const,
  }],
} as const

const NATIVE_SNAPSHOT = {
  entries: [
    {
      entryId: 'browser' as never,
      moduleName: '@bosch/bh-browser-electron',
      enabled: false,
      toggleable: true,
      fiberPhase: null,
    },
    {
      entryId: 'settings' as never,
      moduleName: '@bosch/bh-settings',
      enabled: true,
      toggleable: false,
      fiberPhase: 'active' as const,
    },
  ],
} as const

function nativeControls(): NativePluginControls {
  return {
    list: vi.fn(async () => NATIVE_SNAPSHOT),
    setEnabled: vi.fn(async () => ({
      entries: [
        { ...NATIVE_SNAPSHOT.entries[0], enabled: true, fiberPhase: 'active' as const },
        NATIVE_SNAPSHOT.entries[1],
      ],
    })),
  }
}

describe('PluginInventorySettingsTab', () => {
  it('lists native BH plugins without imported bundle controls', async () => {
    const native = nativeControls()
    render(<PluginInventorySettingsTab {...({ t, nativePlugins: native } as PluginInventorySettingsTabProps)} />)

    expect(await screen.findByRole('heading', { name: en.catalog })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'browser' } })
    expect(screen.getByText('browser-electron')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: `${en.enablePlugin} browser-electron` }))
    await waitFor(() => { expect(native.setEnabled).toHaveBeenCalledWith('browser', true) })
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'settings' } })
    const protectedSwitch = screen.getByRole('switch', { name: `${en.disablePlugin} settings` })
    expect(protectedSwitch.hasAttribute('disabled')).toBe(true)
    fireEvent.click(protectedSwitch)
    expect(native.setEnabled).toHaveBeenCalledOnce()
    expect(screen.queryByText('Ponytail')).toBeNull()
    expect(screen.queryByRole('heading', { name: en.importedPlugins })).toBeNull()
  })
})

describe('ImportedPluginCapabilitiesTab', () => {
  it('keeps skills and hook trust in their own tabs', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    const trust = vi.fn(async () => SNAPSHOT)
    const skills = { t, list, capability: 'skills' } as ImportedPluginCapabilitiesTabProps
    const hooks = { t, list, capability: 'hooks', trust } as ImportedPluginCapabilitiesTabProps
    const { rerender } = render(<ImportedPluginCapabilitiesTab {...skills} />)

    expect(await screen.findByText('ponytail-help')).toBeTruthy()
    expect(screen.queryByText('PreToolUse')).toBeNull()
    rerender(<ImportedPluginCapabilitiesTab {...hooks} />)
    expect(await screen.findByText('PreToolUse')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.importedPluginTrust }))
    await waitFor(() => { expect(trust).toHaveBeenCalledWith('ponytail@local') })
  })
})
