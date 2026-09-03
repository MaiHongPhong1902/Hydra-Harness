// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportedPluginCapabilitiesTab, type ImportedPluginCapabilitiesTabProps } from '../src/client/ImportedPluginCapabilitiesTab.tsx'
import {
  PluginInventorySettingsTab,
  type ImportedPluginControls,
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
      restartRequired: false,
      toggleable: true,
      fiberPhase: null,
    },
    {
      entryId: 'settings' as never,
      moduleName: '@bosch/bh-settings',
      enabled: true,
      restartRequired: false,
      toggleable: false,
      fiberPhase: 'active' as const,
    },
  ],
} as const

function nativeControls(): NativePluginControls {
  return {
    list: vi.fn(async () => NATIVE_SNAPSHOT),
    setEnabled: vi.fn(async () => ({
      snapshot: {
        entries: [
          { ...NATIVE_SNAPSHOT.entries[0], enabled: true, fiberPhase: 'active' as const },
          NATIVE_SNAPSHOT.entries[1],
        ],
      },
      restartRequired: false,
    })),
  }
}

function importedControls(): ImportedPluginControls {
  return {
    list: vi.fn(async () => SNAPSHOT),
    import: vi.fn(async () => SNAPSHOT),
    enable: vi.fn(async () => SNAPSHOT),
    disable: vi.fn(async () => SNAPSHOT),
    remove: vi.fn(async () => ({ plugins: [] })),
  }
}

describe('PluginInventorySettingsTab', () => {
  it('lists native BH plugins without imported bundle controls', async () => {
    const native = nativeControls()
    const { rerender } = render(
      <PluginInventorySettingsTab {...({ t, nativePlugins: native, query: 'browser' } as PluginInventorySettingsTabProps)} />,
    )

    expect(await screen.findByRole('heading', { name: en.catalog })).toBeTruthy()
    expect(screen.getByText('browser-electron')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: `${en.enablePlugin} browser-electron` }))
    await waitFor(() => { expect(native.setEnabled).toHaveBeenCalledWith('browser', true) })
    rerender(<PluginInventorySettingsTab {...({ t, nativePlugins: native, query: 'settings' } as PluginInventorySettingsTabProps)} />)
    const protectedSwitch = await screen.findByRole('switch', { name: `${en.disablePlugin} settings` })
    expect(protectedSwitch.hasAttribute('disabled')).toBe(true)
    fireEvent.click(protectedSwitch)
    expect(native.setEnabled).toHaveBeenCalledOnce()
    expect(screen.queryByText('Ponytail')).toBeNull()
    expect(screen.queryByRole('heading', { name: en.importedPlugins })).toBeNull()
  })

  it('shows the core restart and preset new-session notices', async () => {
    const core = {
      entryId: 'typert-loader' as never,
      moduleName: '@bosch/bh-typert-loader',
      enabled: true,
      restartRequired: false,
      toggleable: true,
      fiberPhase: 'active' as const,
    }
    const preset = {
      entryId: 'agent-preset:standard:tool-subagent' as never,
      moduleName: '@bosch/bh-tool-subagent',
      enabled: true,
      presetId: 'standard',
      newSessionsOnly: true,
      restartRequired: false,
      toggleable: true,
      fiberPhase: null,
    }
    const native: NativePluginControls = {
      list: vi.fn(async () => ({ entries: [core, preset] })),
      setEnabled: vi.fn(async () => ({
        snapshot: { entries: [{ ...core, pendingEnabled: false, restartRequired: true }, preset] },
        restartRequired: true,
      })),
    }
    render(<PluginInventorySettingsTab {...({ t, nativePlugins: native, query: '' } as PluginInventorySettingsTabProps)} />)

    expect(await screen.findByText(`${en.preset}: standard`)).toBeTruthy()
    expect(screen.getByText(en.newSessionsOnly)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: `${en.disablePlugin} typert-loader` }))
    await waitFor(() => { expect(native.setEnabled).toHaveBeenCalledWith('typert-loader', false) })
    expect(await screen.findByText(en.restartRequired)).toBeTruthy()
    expect(screen.getByText('typert-loader').closest('[data-restart-required]')?.getAttribute('data-restart-required')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe(en.restartFooter)
  })

  it('groups repeated modules without merging their switches', async () => {
    const entries = [
      {
        entryId: 'agent-preset:standard:tool-subagent' as never,
        moduleName: '@bosch/bh-tool-subagent',
        enabled: true,
        presetId: 'standard',
        newSessionsOnly: true,
        restartRequired: false,
        toggleable: true,
        fiberPhase: null,
      },
      {
        entryId: 'agent-preset:standard:tool-subagent-fork' as never,
        moduleName: '@bosch/bh-tool-subagent',
        enabled: false,
        presetId: 'standard',
        newSessionsOnly: true,
        restartRequired: false,
        toggleable: true,
        fiberPhase: null,
      },
    ] as const
    const native: NativePluginControls = {
      list: vi.fn(async () => ({ entries })),
      setEnabled: vi.fn(async () => ({ snapshot: { entries }, restartRequired: false })),
    }
    const { container } = render(<PluginInventorySettingsTab {...({ t, nativePlugins: native, query: '' } as PluginInventorySettingsTabProps)} />)

    await screen.findByRole('switch', { name: `${en.disablePlugin} tool-subagent (standard: tool-subagent)` })
    expect(container.querySelectorAll('[data-plugin-module="@bosch/bh-tool-subagent"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-plugin-entry]')).toHaveLength(2)
    expect(container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('1')
    fireEvent.click(screen.getByRole('switch', { name: `${en.enablePlugin} tool-subagent (standard: tool-subagent-fork)` }))
    await waitFor(() => {
      expect(native.setEnabled).toHaveBeenCalledWith('agent-preset:standard:tool-subagent-fork', true)
    })
  })

  it('manages imported OpenAI/Codex plugins alongside native plugins', async () => {
    const native = nativeControls()
    const imported = importedControls()
    render(<PluginInventorySettingsTab {...({ t, nativePlugins: native, importedPlugins: imported, query: '' } as PluginInventorySettingsTabProps)} />)

    expect(await screen.findByText('Ponytail')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: `${en.importedPluginEnable} Ponytail` }))
    await waitFor(() => { expect(imported.enable).toHaveBeenCalledWith('ponytail@local') })
    fireEvent.click(screen.getByRole('button', { name: en.importedPluginRemove }))
    await waitFor(() => { expect(imported.remove).toHaveBeenCalledWith('ponytail@local') })
  })

  it('groups imported plugins by their marketplace owner, filtered by the shared query', async () => {
    const grouped = {
      plugins: [
        {
          identity: 'ponytail@abc' as never,
          name: 'Ponytail',
          version: '1.0.0',
          source: {
            kind: 'marketplace-git' as const,
            source: 'https://github.com/DietrichGebert/ponytail',
            sourceId: 'abc',
            marketplace: 'https://github.com/DietrichGebert/ponytail',
          },
          pluginRoot: 'x', dataPath: 'y', enabled: true, lifecycle: 'installed' as const,
          hookTrustState: 'not-applicable' as const, skills: [], mcpServers: [], hooks: [],
          installationStatus: 'installed' as const,
        },
        {
          identity: 'other@local' as never,
          name: 'Other',
          version: '1.0.0',
          source: { kind: 'local' as const, source: 'C:\\plugins\\other', sourceId: 'local' },
          pluginRoot: 'x', dataPath: 'y', enabled: true, lifecycle: 'installed' as const,
          hookTrustState: 'not-applicable' as const, skills: [], mcpServers: [], hooks: [],
          installationStatus: 'installed' as const,
        },
      ],
    }
    const native = nativeControls()
    const imported: ImportedPluginControls = { ...importedControls(), list: vi.fn(async () => grouped) }
    const { rerender } = render(
      <PluginInventorySettingsTab {...({ t, nativePlugins: native, importedPlugins: imported, query: '' } as PluginInventorySettingsTabProps)} />,
    )

    expect(await screen.findByText('DietrichGebert')).toBeTruthy()
    expect(screen.getByText('Ponytail')).toBeTruthy()
    expect(screen.getByText('other')).toBeTruthy()
    expect(screen.getByText('Other')).toBeTruthy()

    rerender(
      <PluginInventorySettingsTab {...({ t, nativePlugins: native, importedPlugins: imported, query: 'ponytail' } as PluginInventorySettingsTabProps)} />,
    )
    await waitFor(() => { expect(screen.queryByText('Other')).toBeNull() })
    expect(screen.queryByText('other')).toBeNull()
    expect(screen.getByText('DietrichGebert')).toBeTruthy()
    expect(screen.getByText('Ponytail')).toBeTruthy()
  })
})

/** A fixture plugin imported from a real-shaped marketplace, with skills, hooks, and an MCP server populated. */
const MARKETPLACE_SNAPSHOT = {
  plugins: [{
    identity: 'ponytail@dg1' as never,
    name: 'Ponytail',
    version: '2.0.0',
    source: {
      kind: 'marketplace-git' as const,
      source: 'https://github.com/DietrichGebert/ponytail',
      sourceId: 'dg1',
      marketplace: 'https://github.com/DietrichGebert/ponytail',
    },
    pluginRoot: 'C:\\home\\plugins\\ponytail@dg1',
    dataPath: 'C:\\home\\plugins\\ponytail@dg1\\data',
    enabled: true,
    lifecycle: 'installed' as const,
    hookTrustState: 'pending' as const,
    skills: ['ponytail-lint', 'ponytail-review'],
    mcpServers: [{
      name: 'ponytail-mcp',
      enabled: true,
      startupState: 'started' as const,
      authenticationState: 'not-applicable' as const,
      defaultToolsApprovalMode: 'ask' as const,
      toolApproval: {},
      tools: ['ponytail.lint'],
    }],
    hooks: ['PreToolUse', 'Stop'],
    installationStatus: 'installed' as const,
  }],
} as const

describe('ImportedPluginCapabilitiesTab', () => {
  it('groups a marketplace plugin\'s skills under its owner, DietrichGebert', async () => {
    const list = vi.fn(async () => MARKETPLACE_SNAPSHOT)
    render(<ImportedPluginCapabilitiesTab {...({ t, list, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps)} />)

    expect(await screen.findByText('DietrichGebert')).toBeTruthy()
    expect(screen.getByText('ponytail-lint')).toBeTruthy()
    expect(screen.getByText('ponytail-review')).toBeTruthy()
  })

  it('groups a marketplace plugin\'s hooks under its owner and keeps the trust action', async () => {
    const list = vi.fn(async () => MARKETPLACE_SNAPSHOT)
    const trusted = { plugins: [{ ...MARKETPLACE_SNAPSHOT.plugins[0], hookTrustState: 'trusted' as const }] }
    const trust = vi.fn(async () => trusted)
    const untrust = vi.fn(async () => trusted)
    render(<ImportedPluginCapabilitiesTab {...({ t, list, trust, untrust, capability: 'hooks', query: '' } as ImportedPluginCapabilitiesTabProps)} />)

    expect(await screen.findByText('DietrichGebert')).toBeTruthy()
    expect(screen.getByText('PreToolUse')).toBeTruthy()
    expect(screen.getByText('Stop')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.importedPluginTrust }))
    await waitFor(() => { expect(trust).toHaveBeenCalledWith('ponytail@dg1') })
    expect(await screen.findByRole('button', { name: en.importedPluginUntrust })).toBeTruthy()
  })
  it('keeps skills and hook trust in their own tabs', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    const trust = vi.fn(async () => SNAPSHOT)
    const skills = { t, list, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps
    const hooks = { t, list, capability: 'hooks', trust, query: '' } as ImportedPluginCapabilitiesTabProps
    const { rerender } = render(<ImportedPluginCapabilitiesTab {...skills} />)

    expect(await screen.findByText('ponytail-help')).toBeTruthy()
    expect(screen.queryByText('PreToolUse')).toBeNull()
    rerender(<ImportedPluginCapabilitiesTab {...hooks} />)
    expect(await screen.findByText('PreToolUse')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.importedPluginTrust }))
    await waitFor(() => { expect(trust).toHaveBeenCalledWith('ponytail@local') })
  })

  it('filters rows by the shared query and groups them by marketplace owner', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    const skills = { t, list, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps
    const { rerender } = render(<ImportedPluginCapabilitiesTab {...skills} />)

    expect(await screen.findByRole('heading', { name: 'ponytail', level: 4 })).toBeTruthy()
    expect(screen.getByText('Ponytail')).toBeTruthy()

    rerender(<ImportedPluginCapabilitiesTab {...{ ...skills, query: 'no-match' }} />)
    await waitFor(() => { expect(screen.queryByText('Ponytail')).toBeNull() })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })
})
