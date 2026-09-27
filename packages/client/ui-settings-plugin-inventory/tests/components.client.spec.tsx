// @vitest-environment jsdom
import { useState, useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@hydra1902/harness-client-runtime/client'
import { bindSnapshotSelector } from '@hydra1902/harness-client-test-runtime'
import type { ImportedPluginSnapshot, PluginInventorySnapshot } from '@hydra1902/harness-api-remotes/client'
import { PluginInventoryController } from '../src/client/inventory-controller.ts'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    description: 'Tools for project maintenance.',
    application: 'Use the toolkit skill to review a project.',
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
      moduleName: '@hydra1902/harness-browser-electron',
      enabled: false,
      restartRequired: false,
      toggleable: true,
      fiberPhase: null,
    },
    {
      entryId: 'settings' as never,
      moduleName: '@hydra1902/harness-settings',
      description: 'Shared app preferences.',
      application: 'Keep preferences consistent across sessions.',
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
  it.each([false, true])('drops native and imported listings after unmount (reject: %s)', async (reject) => {
    const pending = Promise.withResolvers<undefined>()
    const native = { ...nativeControls(), list: async () => { await pending.promise; return NATIVE_SNAPSHOT } }
    const imported = { ...importedControls(), list: async () => { await pending.promise; return SNAPSHOT } }
    const view = render(<PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, importedPlugins: imported, query: '' } as PluginInventorySettingsTabProps)} />)
    view.unmount()
    await act(async () => { if (reject) pending.reject(new Error('closed')); else pending.resolve(undefined) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retries failed catalogs and reports refused native and imported changes', async () => {
    const native = nativeControls()
    const imported = importedControls()
    vi.mocked(native.list).mockRejectedValueOnce(new Error('offline'))
    vi.mocked(imported.list).mockRejectedValueOnce(new Error('offline'))
    vi.mocked(native.setEnabled).mockRejectedValueOnce(new Error('refused'))
    vi.mocked(imported.enable).mockRejectedValueOnce(new Error('refused'))
    const drafts = createSnapshotStore({ saving: false, error: 'disk full', revision: 0,
      dirtyNative: ['browser'], dirtyImported: ['toolkit@local'], changedNative: ['browser'], changedImported: ['toolkit@local'] })
    const savePlugins = vi.fn(async () => {})
    const discardPluginChanges = vi.fn()
    render(<InventoryTab {...({ active: true, t, nativePlugins: native, importedPlugins: imported, query: '',
      usePluginDrafts: bindSnapshotSelector(drafts), savePlugins, discardPluginChanges } as PluginInventorySettingsTabProps)} />)
    await screen.findByText(en.error)
    await screen.findByText(en.importedPluginLoadError)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    fireEvent.click(screen.getByRole('button', { name: en.importedPluginRetry }))
    fireEvent.click(await screen.findByRole('switch', { name: `${en.enablePlugin} browser-electron` }))
    await screen.findByText(en.toggleError)
    fireEvent.click(await screen.findByRole('switch', { name: `${en.importedPluginEnable} Toolkit` }))
    await screen.findByText(en.importedPluginMutationError)
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    fireEvent.click(screen.getByRole('button', { name: en.saveAll }))
    expect(discardPluginChanges).toHaveBeenCalledOnce()
    expect(savePlugins).toHaveBeenCalledOnce()
    await act(async () => { drafts.update((state) => { state.saving = true }) })
    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
  })

  it('shows grouped deployment rows, related modules, mixed state and unobserved fibers', async () => {
    const native = nativeControls()
    const entries: PluginInventorySnapshot['entries'] = [
      { ...NATIVE_SNAPSHOT.entries[0], moduleName: 'cordis:group', enabled: true, mixedEnabled: true, relatedModules: ['related'], fiberPhase: null },
      { ...NATIVE_SNAPSHOT.entries[0], entryId: 'second' as never, moduleName: 'cordis:group', enabled: false, toggleable: false },
    ]
    vi.mocked(native.list).mockResolvedValue({ entries })
    render(<PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, query: '' } as PluginInventorySettingsTabProps)} />)
    await screen.findByText('group')
    const groupRow = screen.getByText('group').closest('[role="button"]')!
    expect(groupRow.querySelector('[data-status="unmounted"]')).not.toBeNull()
    fireEvent.keyDown(groupRow, { key: 'ArrowDown' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(groupRow, { key: ' ' })
    fireEvent.click(groupRow)
    const groupDetails = screen.getByRole('dialog', { name: 'group' })
    expect(groupDetails.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText(en.mixedEnabled)).not.toBeNull()
    expect(within(groupDetails).getByText(en.cordis)).not.toBeNull()
    expect(within(groupDetails).getByText(en.unobserved)).not.toBeNull()
    expect(screen.getByText('related')).not.toBeNull()
  })

  it('filters compact rows and opens the selected plugin dialog', async () => {
    const native = nativeControls()
    vi.mocked(native.list).mockResolvedValue({ entries: [
      { ...NATIVE_SNAPSHOT.entries[0], pluginType: 'normal', moduleName: '@hydra1902/harness-browser-electron' },
      { ...NATIVE_SNAPSHOT.entries[1], pluginType: 'core', moduleName: '@hydra1902/harness-settings' },
    ] })
    render(<PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, query: '' } as PluginInventorySettingsTabProps)} />)
    await screen.findByText('browser-electron')
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'core' } })
    expect(screen.queryByText('browser-electron')).toBeNull()
    fireEvent.click(screen.getByText('settings').closest('[role="button"]')!)
    const details = await screen.findByRole('dialog', { name: 'settings' })
    expect(details.getAttribute('aria-modal')).toBe('true')
    expect(within(details).getByRole('row', { name: 'Description Shared app preferences.' })).toBeTruthy()
    expect(within(details).getByRole('row', { name: 'Usage Keep preferences consistent across sessions.' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'settings' })).toBeNull()
  })

  it('shows an empty native catalog and explains an unavailable inventory', async () => {
    const native = nativeControls()
    vi.mocked(native.list).mockResolvedValue({ entries: [] })
    render(<PluginInventorySettingsTab {...({ active: true, t, nativePlugins: native, query: '' } as PluginInventorySettingsTabProps)} />)
    await screen.findByText(en.empty)
    cleanup()
    render(<PluginInventorySettingsTab {...({ active: true, t, query: '' } as PluginInventorySettingsTabProps)} />)
    expect(screen.getByText(en.pluginUnavailable)).not.toBeNull()
  })

  it('sorts imported siblings, stages disablement and reports an empty search', async () => {
    const imported = importedControls()
    vi.mocked(imported.list).mockResolvedValue({ plugins: [
      { ...SNAPSHOT.plugins[0], enabled: true }, { ...SNAPSHOT.plugins[0], identity: 'alpha@local' as never, name: 'Alpha' },
    ] })
    const props = { active: true, t, nativePlugins: nativeControls(), importedPlugins: imported, query: '' } as PluginInventorySettingsTabProps
    const view = render(<PluginInventorySettingsTab {...props} />)
    fireEvent.click(await screen.findByRole('switch', { name: `${en.importedPluginDisable} Toolkit` }))
    expect(imported.disable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.saveAll }))
    await waitFor(() => { expect(imported.disable).toHaveBeenCalledWith('toolkit@local') })
    view.rerender(<PluginInventorySettingsTab {...props} query="absent" />)
    await waitFor(() => { expect(screen.queryByText('Toolkit')).toBeNull() })
    expect(screen.getAllByText(en.emptySearch).length).toBeGreaterThan(0)
  })

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
    fireEvent.click((await screen.findByText('settings')).closest('[role="button"]')!)
    await screen.findByText(en.requiredPlugin)
    expect(screen.queryByRole('switch', { name: `${en.disablePlugin} settings` })).toBeNull()
    expect(native.setEnabled).toHaveBeenCalledOnce()
    expect(screen.queryByText('Toolkit')).toBeNull()
    expect(screen.queryByRole('heading', { name: en.importedPlugins })).toBeNull()
  })

  it('shows the core restart and preset session-scope notices', async () => {
    const core = {
      entryId: 'typert-loader' as never,
      moduleName: '@hydra1902/harness-typert-loader',
      pluginType: 'core' as const,
      enabled: true,
      restartRequired: false,
      toggleable: true,
      fiberPhase: 'active' as const,
    }
    const preset = {
      entryId: 'agent-preset:standard:tool-subagent' as never,
      moduleName: '@hydra1902/harness-tool-subagent',
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

    const presetRow = (await screen.findByText('tool-subagent')).closest('[role="button"]')!
    expect(within(presetRow as HTMLElement).getByText(en.sessionScoped)).toBeTruthy()
    expect(within(presetRow as HTMLElement).queryByText(en.unobserved)).toBeNull()
    fireEvent.click(presetRow)
    expect(await screen.findByText('standard')).toBeTruthy()
    const details = screen.getByRole('dialog', { name: 'tool-subagent' })
    expect(within(details).getByRole('row', { name: `${en.cordis} ${en.sessionScoped}` })).toBeTruthy()
    expect(within(details).getByText(en.presetRuntimeHint)).toBeTruthy()
    expect(screen.getByText(en.newSessionsOnly)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.closeDetails }))
    fireEvent.click(screen.getByRole('switch', { name: `${en.disablePlugin} typert-loader` }))
    expect(native.setEnabled).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.saveAll }))
    await waitFor(() => { expect(native.setEnabled).toHaveBeenCalledWith('typert-loader', false) })
    fireEvent.click(screen.getByText('typert-loader').closest('[role="button"]')!)
    expect(await screen.findByText(en.restartRequired)).toBeTruthy()
    expect(document.querySelector('[data-plugin-entry="typert-loader"]')?.getAttribute('data-restart-required')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain(en.restartFooter)
    expect(screen.getByRole('status').textContent).toContain(en.restartCount)
  })

  it('covers native runtime states, filters, sorting, and keyboard details', async () => {
    const entries: PluginInventorySnapshot['entries'] = [
      { ...NATIVE_SNAPSHOT.entries[0], entryId: 'failed' as never, moduleName: '@hydra1902/harness-failed', pluginType: 'normal', enabled: true, fiberPhase: 'failed' },
      { ...NATIVE_SNAPSHOT.entries[0], entryId: 'failed-two' as never, moduleName: '@hydra1902/harness-failed-two', pluginType: 'normal', enabled: true, fiberPhase: 'failed' },
      { ...NATIVE_SNAPSHOT.entries[0], entryId: 'loading' as never, moduleName: '@hydra1902/harness-loading', pluginType: 'normal', enabled: true, fiberPhase: 'loading' },
      { ...NATIVE_SNAPSHOT.entries[0], entryId: 'stopped' as never, moduleName: '@hydra1902/harness-stopped', pluginType: 'normal', enabled: false, fiberPhase: null },
      { ...NATIVE_SNAPSHOT.entries[0], entryId: 'core-restart' as never, moduleName: '@hydra1902/harness-core-restart', pluginType: 'core', enabled: true, restartRequired: true, fiberPhase: 'active' },
      { ...NATIVE_SNAPSHOT.entries[0], entryId: 'preset-filter' as never, moduleName: '@hydra1902/harness-preset-filter', enabled: true, presetId: 'standard', fiberPhase: null },
    ]
    const native: NativePluginControls = {
      list: vi.fn(async () => ({ entries })),
      setEnabled: vi.fn(async () => ({ snapshot: { entries }, restartRequired: false })),
    }
    const drafts = createSnapshotStore({ saving: false, error: null, revision: 0,
      dirtyNative: ['failed'], dirtyImported: [], changedNative: ['failed'], changedImported: [] })
    render(<InventoryTab {...({
      active: true,
      t,
      nativePlugins: native,
      importedPlugins: importedControls(),
      query: '',
      usePluginDrafts: bindSnapshotSelector(drafts),
      savePlugins: vi.fn(async () => {}),
      discardPluginChanges: vi.fn(),
    } as PluginInventorySettingsTabProps)} />)

    await screen.findByText('failed')
    const [typeFilter, statusFilter, sortOrder] = screen.getAllByRole('combobox')
    fireEvent.change(sortOrder!, { target: { value: 'status' } })
    fireEvent.change(typeFilter!, { target: { value: 'extension' } })
    fireEvent.change(statusFilter!, { target: { value: 'enabled' } })
    const failedRow = screen.getByText('failed').closest('[role="button"]')!
    fireEvent.keyDown(failedRow, { key: 'Enter' })
    const details = await screen.findByRole('dialog', { name: 'failed' })
    expect(within(details).getByText(en.unsaved)).toBeTruthy()
    expect(within(details).getByText(en.changedSinceStart)).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: en.closeDetails }))

    fireEvent.change(statusFilter!, { target: { value: 'disabled' } })
    expect(await screen.findByText('stopped')).toBeTruthy()
    fireEvent.change(statusFilter!, { target: { value: 'all' } })
    fireEvent.change(typeFilter!, { target: { value: 'preset' } })
    expect(await screen.findByText('preset-filter')).toBeTruthy()
    fireEvent.change(typeFilter!, { target: { value: 'core' } })
    fireEvent.change(statusFilter!, { target: { value: 'restart' } })
    expect(await screen.findByText('core-restart')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: en.importedPlugins })).toBeNull()
  })

  it('covers imported filters, keyboard details, missing metadata, and draft notices', async () => {
    const imported = importedControls()
    const { description: _description, application: _application, ...missingMetadata } = SNAPSHOT.plugins[0]
    vi.mocked(imported.list).mockResolvedValue({ plugins: [
      { ...missingMetadata, enabled: true },
      { ...SNAPSHOT.plugins[0], identity: 'disabled@local' as never, name: 'Disabled', enabled: false },
      { ...SNAPSHOT.plugins[0], identity: 'enabled-two@local' as never, name: 'Enabled two', enabled: true },
    ] })
    const drafts = createSnapshotStore({ saving: false, error: null, revision: 0,
      dirtyNative: [], dirtyImported: ['toolkit@local'], changedNative: [], changedImported: ['toolkit@local'] })
    render(<InventoryTab {...({
      active: true,
      t,
      nativePlugins: nativeControls(),
      importedPlugins: imported,
      query: '',
      usePluginDrafts: bindSnapshotSelector(drafts),
      savePlugins: vi.fn(async () => {}),
      discardPluginChanges: vi.fn(),
    } as PluginInventorySettingsTabProps)} />)

    const toolkit = await screen.findByText('Toolkit')
    fireEvent.keyDown(toolkit.closest('[role="button"]')!, { key: 'ArrowDown' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(toolkit.closest('[role="button"]')!, { key: ' ' })
    const details = await screen.findByRole('dialog', { name: 'Toolkit' })
    expect(within(details).getAllByText(en.metadataMissing)).toHaveLength(2)
    expect(within(details).getByText(en.unsaved)).toBeTruthy()
    expect(within(details).getByText(en.changedSinceStart)).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: en.closeDetails }))

    const [, statusFilter, sortOrder] = screen.getAllByRole('combobox')
    fireEvent.change(statusFilter!, { target: { value: 'disabled' } })
    await waitFor(() => { expect(document.querySelector('[data-imported-plugin="disabled@local"]')).not.toBeNull() })
    fireEvent.change(statusFilter!, { target: { value: 'all' } })
    fireEvent.change(sortOrder!, { target: { value: 'status' } })
    fireEvent.change(statusFilter!, { target: { value: 'restart' } })
    expect(screen.queryByRole('heading', { name: en.importedPlugins })).toBeNull()
  })

  it('groups repeated modules without merging their switches', async () => {
    const entries = [
      {
        entryId: 'agent-preset:standard:tool-subagent' as never,
        moduleName: '@hydra1902/harness-tool-subagent',
        enabled: true,
        presetId: 'standard',
        newSessionsOnly: true,
        restartRequired: false,
        toggleable: true,
        fiberPhase: null,
      },
      {
        entryId: 'agent-preset:standard:tool-subagent-fork' as never,
        moduleName: '@hydra1902/harness-tool-subagent',
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
    expect(container.querySelectorAll('[data-plugin-module="@hydra1902/harness-tool-subagent"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-plugin-entry]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-plugin-entry] [data-status="session-scoped"]')).toHaveLength(2)
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

    const toolkit = await screen.findByText('Toolkit')
    fireEvent.click(toolkit.closest('[role="button"]')!)
    const details = await screen.findByRole('dialog', { name: 'Toolkit' })
    expect(details.querySelector('table')).not.toBeNull()
    expect(within(details).getByText(SNAPSHOT.plugins[0].description)).toBeTruthy()
    expect(within(details).getByText(SNAPSHOT.plugins[0].application)).toBeTruthy()
    expect(within(details).queryByRole('button', { name: en.importedPluginRemove })).toBeNull()
    fireEvent.click(within(details).getByRole('button', { name: en.closeDetails }))
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
  it('renders a stable native-skill placeholder before hydration', async () => {
    const { renderToString } = await vi.importActual<{ renderToString: (element: React.ReactElement) => string }>('react-dom/server')
    const html = renderToString(<ImportedPluginCapabilitiesTab {...({ active: true, t, list: async () => SNAPSHOT,
      capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps)} />)
    expect(html).toContain(en.nativeSkillsUnavailable)
  })

  it.each([false, true])('ignores capability responses after closing an inactive tab (reject: %s)', async (reject) => {
    const pending = Promise.withResolvers<undefined>()
    const list = vi.fn(async () => { await pending.promise; return SNAPSHOT })
    const nativeSkills = { list: vi.fn(async () => { await pending.promise; return { skills: [] } }) }
    const props = { t, list, nativeSkills, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps
    const view = render(<ImportedPluginCapabilitiesTab {...props} active={false} />)
    expect(list).not.toHaveBeenCalled()
    expect(nativeSkills.list).not.toHaveBeenCalled()
    view.rerender(<ImportedPluginCapabilitiesTab {...props} active />)
    view.unmount()
    await act(async () => { if (reject) pending.reject(new Error('closed')); else pending.resolve(undefined) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retries imported and native skill failures and filters native descriptions', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ plugins: [] })
    const nativeList = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ sessionId: 's', skills: [] })
    const props = { active: true, t, list, nativeSkills: { list: nativeList }, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps
    const view = render(<ImportedPluginCapabilitiesTab {...props} />)
    await screen.findByText(en.importedPluginLoadError)
    await screen.findByText(en.nativeSkillsLoadError)
    fireEvent.click(screen.getAllByRole('button', { name: en.retry })[0]!)
    await screen.findByText(en.nativeSkillsEmpty)
    nativeList.mockResolvedValue({ sessionId: 's', skills: [{ name: 'local', description: 'Local skill', modelInvocable: true }] })
    view.rerender(<ImportedPluginCapabilitiesTab {...props} active={false} />)
    view.rerender(<ImportedPluginCapabilitiesTab {...props} active />)
    await screen.findByText('Local skill')
    view.rerender(<ImportedPluginCapabilitiesTab {...props} query="absent" />)
    expect(screen.getByText(en.nativeSkillsEmptySearch)).not.toBeNull()
  })

  it('retries native skills independently of a successful imported listing', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ sessionId: 's', skills: [] })
    render(<ImportedPluginCapabilitiesTab {...({ active: true, t, list: async () => SNAPSHOT,
      nativeSkills: { list }, capability: 'skills', query: '' } as ImportedPluginCapabilitiesTabProps)} />)
    await screen.findByText(en.nativeSkillsLoadError)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await screen.findByText(en.nativeSkillsEmpty)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('refreshes hook trust after a failed mutation and renders an empty hooks catalog', async () => {
    const list = vi.fn<() => Promise<ImportedPluginSnapshot>>().mockResolvedValue(SNAPSHOT)
    const trust = vi.fn().mockRejectedValue(new Error('refused'))
    const props = { active: true, t, list, trust, capability: 'hooks', query: '' } as ImportedPluginCapabilitiesTabProps
    const view = render(<ImportedPluginCapabilitiesTab {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: en.importedPluginTrust }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole('alert').textContent).toBe(en.importedPluginMutationError)
    list.mockResolvedValue({ plugins: [] })
    view.rerender(<ImportedPluginCapabilitiesTab {...props} active={false} />)
    view.rerender(<ImportedPluginCapabilitiesTab {...props} active />)
    await screen.findByText(en.importedPluginNoHooks)
  })

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
    fireEvent.click(screen.getByRole('button', { name: en.importedPluginUntrust }))
    await waitFor(() => { expect(untrust).toHaveBeenCalledWith('toolkit@ex1') })
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
