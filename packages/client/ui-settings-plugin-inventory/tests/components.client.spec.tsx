// @vitest-environment jsdom
import { useState, useSyncExternalStore } from 'react'
import { PluginInventoryController } from '../src/client/inventory-controller.ts'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportedPluginCapabilitiesTab, type ImportedPluginCapabilitiesTabProps } from '../src/client/ImportedPluginCapabilitiesTab.tsx'
import {
  PluginInventorySettingsTab as InventoryTab,
  type ImportedPluginControls,
  type NativePluginControls,
  type PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginInventoryLocaleKey): string => en[key]) as PluginInventorySettingsTabProps['t']
const SNAPSHOT = {
  plugins: [{
    identity: 'toolkit@local' as never,
    name: 'Toolkit',
    version: '4.9.0',
    source: { kind: 'local' as const, source: 'C:\\plugins\\toolkit', sourceId: 'local' },
    pluginRoot: 'C:\\plugins\\toolkit',
    dataPath: 'C:\\data\\toolkit',
    enabled: false,
    lifecycle: 'installed' as const,
    hookTrustState: 'pending' as const,
    skills: ['toolkit', 'toolkit-help'],
    mcpServers: [],
    hooks: ['PreToolUse'],
    installationStatus: 'installed' as const,
  }],
} as const

const NATIVE_SNAPSHOT = {
  entries: [
    {
      entryId: 'browser' as never,
      moduleName: '@hydra/harness-browser-electron',
      enabled: false,
      restartRequired: false,
      toggleable: true,
      fiberPhase: null,
    },
    {
      entryId: 'settings' as never,
      moduleName: '@hydra/harness-settings',
      enabled: true,
      restartRequired: false,
      toggleable: false,
      fiberPhase: 'active' as const,
    },
  ],
} as const

function nativeControls(): NativePluginControls {
  let snapshot: Awaited<ReturnType<NativePluginControls['list']>> = NATIVE_SNAPSHOT
  return {
    list: vi.fn(async () => snapshot),
    setEnabled: vi.fn<NativePluginControls['setEnabled']>(async (id, enabled) => {
      snapshot = { entries: snapshot.entries.map(entry => entry.entryId === id ? { ...entry, enabled, fiberPhase: enabled ? 'active' : null } : entry) }
      return { snapshot, restartRequired: false }
    }),
  }
}

function importedControls(): ImportedPluginControls {
  let snapshot: Awaited<ReturnType<ImportedPluginControls['list']>> = SNAPSHOT
  return {
    list: vi.fn(async () => snapshot),
    import: vi.fn(async () => snapshot),
    enable: vi.fn(async () => { snapshot = { plugins: snapshot.plugins.map(plugin => ({ ...plugin, enabled: true })) }; return snapshot }),
    disable: vi.fn(async () => {
      snapshot = { plugins: snapshot.plugins.map(plugin => ({ ...plugin, enabled: false })) }
      return snapshot
    }),
    remove: vi.fn(async () => { snapshot = { plugins: [] }; return snapshot }),
  }
}

function PluginInventorySettingsTab(props: PluginInventorySettingsTabProps) {
  const [controller] = useState(() => new PluginInventoryController(props.nativePlugins, props.importedPlugins))
  return <InventoryTab {...props}
    {...controller.nativePlugins === undefined ? {} : { nativePlugins: controller.nativePlugins }}
    {...controller.importedPlugins === undefined ? {} : { importedPlugins: controller.importedPlugins }}
    usePluginDrafts={selector => selector(useSyncExternalStore(
      listener => controller.store.subscribe(listener), () => controller.store.getSnapshot(),
    ))}
    savePlugins={() => controller.save()}
    discardPluginChanges={() => { controller.discard() }}
  />
}

describe('PluginInventorySettingsTab', () => {
  it('refreshes imported plugins when a retained tab is selected again', async () => {
    const native = nativeControls()
    const imported = importedControls()
    vi.mocked(imported.list).mockResolvedValueOnce({ plugins: [] })
    const props = { active: true, t, nativePlugins: native, importedPlugins: imported, query: '' } as PluginInventorySettingsTabProps
    const view = render(<PluginInventorySettingsTab {...props} />)
    await screen.findByText(en.importedPluginEmpty)
    view.rerender(<PluginInventorySettingsTab {...props} active={false} />)
    expect(imported.list).toHaveBeenCalledTimes(1)
    view.rerender(<PluginInventorySettingsTab {...props} active />)
    await screen.findByText('Toolkit')
    expect(imported.list).toHaveBeenCalledTimes(2)
  })
  it('lists native Hydra plugins without imported bundle controls', async () => {
    const native = nativeControls()
    const { rerender } = render(
      <PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, query: 'browser' } as PluginInventorySettingsTabProps)} />,
    )

    expect(await screen.findByRole('heading', { name: en.catalog })).toBeTruthy()
    expect(screen.getByText('browser-electron')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: `${en.enablePlugin} browser-electron` }))
    expect(native.setEnabled).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.saveAll }))
    await waitFor(() => { expect(native.setEnabled).toHaveBeenCalledWith('browser', true) })
    rerender(<PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, query: 'settings' } as PluginInventorySettingsTabProps)} />)
    await screen.findByText(en.requiredPlugin)
    expect(screen.queryByRole('switch', { name: `${en.disablePlugin} settings` })).toBeNull()
    expect(native.setEnabled).toHaveBeenCalledOnce()
    expect(screen.queryByText('Toolkit')).toBeNull()
    expect(screen.queryByRole('heading', { name: en.importedPlugins })).toBeNull()
  })

  it('shows the core restart and preset new-session notices', async () => {
    const core = {
      entryId: 'typert-loader' as never,
      moduleName: '@hydra/harness-typert-loader',
      pluginType: 'core' as const,
      enabled: true,
      restartRequired: false,
      toggleable: true,
      fiberPhase: 'active' as const,
    }
    const preset = {
      entryId: 'agent-preset:standard:tool-subagent' as never,
      moduleName: '@hydra/harness-tool-subagent',
      enabled: true,
      presetId: 'standard',
      newSessionsOnly: true,
      restartRequired: false,
      toggleable: true,
      fiberPhase: null,
    }
    let snapshot: Awaited<ReturnType<NativePluginControls['list']>> = { entries: [core, preset] }
    const native: NativePluginControls = {
      list: vi.fn(async () => snapshot),
      setEnabled: vi.fn(async () => {
        snapshot = { entries: [{ ...core, pendingEnabled: false, restartRequired: true }, preset] }
        return { snapshot, restartRequired: true }
      }),
    }
    render(<PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, query: '' } as PluginInventorySettingsTabProps)} />)

    expect(await screen.findByText(`${en.preset}: standard`)).toBeTruthy()
    expect(screen.getByText(en.newSessionsOnly)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: `${en.disablePlugin} typert-loader` }))
    expect(native.setEnabled).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.saveAll }))
    await waitFor(() => { expect(native.setEnabled).toHaveBeenCalledWith('typert-loader', false) })
    expect(await screen.findByText(en.restartRequired)).toBeTruthy()
    expect(screen.getByText('typert-loader').closest('[data-restart-required]')?.getAttribute('data-restart-required')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe(en.restartFooter)
  })

  it('groups repeated modules without merging their switches', async () => {
    const entries = [
      {
        entryId: 'agent-preset:standard:tool-subagent' as never,
        moduleName: '@hydra/harness-tool-subagent',
        enabled: true,
        presetId: 'standard',
        newSessionsOnly: true,
        restartRequired: false,
        toggleable: true,
        fiberPhase: null,
      },
      {
        entryId: 'agent-preset:standard:tool-subagent-fork' as never,
        moduleName: '@hydra/harness-tool-subagent',
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
    const { container } = render(<PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, query: '' } as PluginInventorySettingsTabProps)} />)

    await screen.findByRole('switch', { name: `${en.disablePlugin} tool-subagent (standard: tool-subagent)` })
    expect(container.querySelectorAll('[data-plugin-module="@hydra/harness-tool-subagent"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-plugin-entry]')).toHaveLength(2)
    expect(container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('1')
    fireEvent.click(screen.getByRole('switch', { name: `${en.enablePlugin} tool-subagent (standard: tool-subagent-fork)` }))
    fireEvent.click(screen.getByRole('button', { name: en.saveAll }))
    await waitFor(() => {
      expect(native.setEnabled).toHaveBeenCalledWith('agent-preset:standard:tool-subagent-fork', true)
    })
  })

  it('manages imported OpenAI/Codex plugins alongside native plugins', async () => {
    const native = nativeControls()
    const imported = importedControls()
    render(<PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, importedPlugins: imported, query: '' } as PluginInventorySettingsTabProps)} />)

    expect(await screen.findByText('Toolkit')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: `${en.importedPluginEnable} Toolkit` }))
    expect(imported.enable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.saveAll }))
    await waitFor(() => { expect(imported.enable).toHaveBeenCalledWith('toolkit@local') })
    fireEvent.click(screen.getByRole('button', { name: en.importedPluginRemove }))
    await waitFor(() => { expect(imported.remove).toHaveBeenCalledWith('toolkit@local') })
  })

  it('groups imported plugins by their marketplace owner, filtered by the shared query', async () => {
    const grouped = {
      plugins: [
        {
          identity: 'toolkit@abc' as never,
          name: 'Toolkit',
          version: '1.0.0',
          source: {
            kind: 'marketplace-git' as const,
            source: 'https://github.com/example-labs/toolkit',
            sourceId: 'abc',
            marketplace: 'https://github.com/example-labs/toolkit',
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
      <PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, importedPlugins: imported, query: '' } as PluginInventorySettingsTabProps)} />,
    )

    expect(await screen.findByText('example-labs')).toBeTruthy()
    expect(screen.getByText('Toolkit')).toBeTruthy()
    expect(screen.getByText('other')).toBeTruthy()
    expect(screen.getByText('Other')).toBeTruthy()

    rerender(
      <PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, importedPlugins: imported, query: 'toolkit' } as PluginInventorySettingsTabProps)} />,
    )
    await waitFor(() => { expect(screen.queryByText('Other')).toBeNull() })
    expect(screen.queryByText('other')).toBeNull()
    expect(screen.getByText('example-labs')).toBeTruthy()
    expect(screen.getByText('Toolkit')).toBeTruthy()
  })
})

/** A fixture plugin imported from a real-shaped marketplace, with skills, hooks, and an MCP server populated. */
const MARKETPLACE_SNAPSHOT = {
  plugins: [{
    identity: 'toolkit@ex1' as never,
    name: 'Toolkit',
    version: '2.0.0',
    source: {
      kind: 'marketplace-git' as const,
      source: 'https://github.com/example-labs/toolkit',
      sourceId: 'ex1',
      marketplace: 'https://github.com/example-labs/toolkit',
    },
    pluginRoot: 'C:\\home\\plugins\\toolkit@ex1',
    dataPath: 'C:\\home\\plugins\\toolkit@ex1\\data',
    enabled: true,
    lifecycle: 'installed' as const,
    hookTrustState: 'pending' as const,
    skills: ['toolkit-lint', 'toolkit-review'],
    mcpServers: [{
      name: 'toolkit-mcp',
      enabled: true,
      startupState: 'started' as const,
      authenticationState: 'not-applicable' as const,
      defaultToolsApprovalMode: 'ask' as const,
      toolApproval: {},
      tools: ['toolkit.lint'],
    }],
    hooks: ['PreToolUse', 'Stop'],
    installationStatus: 'installed' as const,
  }],
} as const

describe('ImportedPluginCapabilitiesTab', () => {
  it('groups a marketplace plugin\'s skills under its owner, example-labs', async () => {
    const list = vi.fn(async () => MARKETPLACE_SNAPSHOT)
    render(<ImportedPluginCapabilitiesTab {...({ active: true, t, list, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps)} />)

    expect(await screen.findByText('example-labs')).toBeTruthy()
    expect(screen.getByText('toolkit-lint')).toBeTruthy()
    expect(screen.getByText('toolkit-review')).toBeTruthy()
  })

  it('shows current-session skills from the native catalog and omits imported duplicates', async () => {
    const list = vi.fn(async () => MARKETPLACE_SNAPSHOT)
    const nativeSkills = {
      list: vi.fn(async () => ({
        sessionId: 'session-1',
        skills: [
          { name: 'toolkit-lint', description: 'Imported duplicate', modelInvocable: true },
          { name: 'local-review', description: 'Review local changes', whenToUse: 'When reviewing a diff', modelInvocable: true },
        ],
      })),
    }
    render(<ImportedPluginCapabilitiesTab {...({ active: true, t, list, nativeSkills, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps)} />)

    expect(await screen.findByText(en.nativeSkillsTitle)).toBeTruthy()
    expect(await screen.findByText('local-review')).toBeTruthy()
    expect(screen.getAllByText('toolkit-lint')).toHaveLength(1)
  })

  it('explains that native skills need a selected session', async () => {
    const list = vi.fn(async () => ({ plugins: [] }))
    const nativeSkills = { list: vi.fn(async () => ({ skills: [] })) }
    render(<ImportedPluginCapabilitiesTab {...({ active: true, t, list, nativeSkills, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps)} />)

    expect(await screen.findByText(en.nativeSkillsNoSession)).toBeTruthy()
  })

  it('groups a marketplace plugin\'s hooks under its owner and keeps the trust action', async () => {
    const list = vi.fn(async () => MARKETPLACE_SNAPSHOT)
    const trusted = { plugins: [{ ...MARKETPLACE_SNAPSHOT.plugins[0], hookTrustState: 'trusted' as const }] }
    const trust = vi.fn(async () => trusted)
    const untrust = vi.fn(async () => trusted)
    render(<ImportedPluginCapabilitiesTab {...({ active: true, t, list, trust, untrust, capability: 'hooks', query: '' } as ImportedPluginCapabilitiesTabProps)} />)

    expect(await screen.findByText('example-labs')).toBeTruthy()
    expect(screen.getByText('PreToolUse')).toBeTruthy()
    expect(screen.getByText('Stop')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.importedPluginTrust }))
    await waitFor(() => { expect(trust).toHaveBeenCalledWith('toolkit@ex1') })
    expect(await screen.findByRole('button', { name: en.importedPluginUntrust })).toBeTruthy()
  })
  it('keeps skills and hook trust in their own catalogs', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    const trust = vi.fn(async () => SNAPSHOT)
    const skills = { active: true, t, list, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps
    const hooks = { active: true, t, list, capability: 'hooks', trust, query: '' } as ImportedPluginCapabilitiesTabProps
    const { rerender } = render(<ImportedPluginCapabilitiesTab {...skills} />)

    expect(await screen.findByText('toolkit-help')).toBeTruthy()
    expect(screen.queryByText('PreToolUse')).toBeNull()
    rerender(<ImportedPluginCapabilitiesTab {...hooks} />)
    expect(await screen.findByText('PreToolUse')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.importedPluginTrust }))
    await waitFor(() => { expect(trust).toHaveBeenCalledWith('toolkit@local') })
  })

  it('filters rows by the shared query and groups them by marketplace owner', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    const skills = { active: true, t, list, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps
    const { rerender } = render(<ImportedPluginCapabilitiesTab {...skills} />)

    expect(await screen.findByRole('heading', { name: 'toolkit', level: 4 })).toBeTruthy()
    expect(screen.getByText('Toolkit')).toBeTruthy()

    rerender(<ImportedPluginCapabilitiesTab {...{ ...skills, query: 'no-match' }} />)
    await waitFor(() => { expect(screen.queryByText('Toolkit')).toBeNull() })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })
})
