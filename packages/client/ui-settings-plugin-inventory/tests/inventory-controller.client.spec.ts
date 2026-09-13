import { describe, expect, it, vi } from 'vitest'
import type { ImportedPluginSnapshot, PluginInventorySnapshot } from '@hydra/harness-api-remotes/client'
import { PluginInventoryController } from '../src/client/inventory-controller.ts'
import type { ImportedPluginControls, NativePluginControls } from '../src/client/PluginInventorySettingsTab.tsx'

function importedFixture() {
  const identity = 'toolkit@local' as never
  let snapshot: ImportedPluginSnapshot = {
    plugins: [{
      identity,
      name: 'Toolkit',
      version: '1.0.0',
      source: { kind: 'local', source: 'C:\\plugins\\toolkit', sourceId: 'local' },
      pluginRoot: 'C:\\plugins\\toolkit',
      dataPath: 'C:\\data\\toolkit',
      enabled: false,
      initialEnabled: false,
      lifecycle: 'disabled',
      hookTrustState: 'not-applicable',
      skills: [],
      mcpServers: [],
      hooks: [],
      installationStatus: 'installed',
    }],
  }
  let finishRemove!: (next: ImportedPluginSnapshot) => void
  const api: ImportedPluginControls = {
    list: vi.fn(async () => snapshot),
    import: vi.fn(async () => snapshot),
    enable: vi.fn(async () => snapshot),
    disable: vi.fn(async () => snapshot),
    remove: vi.fn(() => new Promise<ImportedPluginSnapshot>((resolve) => { finishRemove = (next) => { snapshot = next; resolve(next) } })),
  }
  const controller = new PluginInventoryController(undefined, api)
  return {
    api,
    controller,
    controls: controller.importedPlugins!,
    identity,
    finishRemove: (next: ImportedPluginSnapshot) => { finishRemove(next) },
  }
}

function fixture() {
  let snapshot: PluginInventorySnapshot = { entries: ['core', 'normal'].map(id => ({
    entryId: id as never, moduleName: id, pluginType: id === 'core' ? 'core' : 'normal',
    enabled: true, initialEnabled: true, restartRequired: false, toggleable: true, fiberPhase: 'active',
  })) }
  const api: NativePluginControls = {
    list: vi.fn(async () => snapshot),
    setEnabled: vi.fn<NativePluginControls['setEnabled']>(async (id, enabled) => {
      snapshot = { entries: snapshot.entries.map(entry => entry.entryId !== id ? entry
        : entry.pluginType === 'core'
          ? { ...entry, pendingEnabled: enabled, restartRequired: enabled !== entry.enabled }
          : { ...entry, enabled }) }
      return { snapshot, restartRequired: id === 'core' }
    }),
  }
  const controller = new PluginInventoryController(api)
  return { api, controller, controls: controller.nativePlugins! }
}

describe('plugin settings drafts', () => {
  it('keeps startup highlights separate from a dirty imported draft', async () => {
    const { controller, controls, identity } = importedFixture()
    await controls.list()
    await controls.enable(identity)

    expect(controller.store.getSnapshot()).toMatchObject({ dirtyImported: [identity], changedImported: [] })
  })

  it('treats an imported removal in progress as a pending change', async () => {
    const { controller, controls, identity, finishRemove } = importedFixture()
    await controls.list()
    const removing = controls.remove(identity)

    expect(controller.hasPendingImportedChanges()).toBe(true)
    finishRemove({ plugins: [] })
    await removing
    expect(controller.hasPendingImportedChanges()).toBe(false)
  })

  it('can turn every member off when a group starts with mixed enablement', async () => {
    const { api, controller, controls } = fixture()
    const initial = await api.list()
    const mixed: PluginInventorySnapshot = { entries: initial.entries.map(entry => ({
      ...entry, enabled: false, mixedEnabled: true, initialEnabled: null, changedSinceStart: false,
    })) }
    vi.mocked(api.list).mockResolvedValue(mixed)
    await controls.list()
    expect(controller.store.getSnapshot().changedNative).toEqual([])
    await controls.setEnabled('normal' as never, true)
    await controls.setEnabled('normal' as never, false)
    await controls.list()
    expect(controller.store.getSnapshot()).toMatchObject({ dirtyNative: ['normal'], changedNative: ['normal'] })
    await controller.save()
    expect(api.setEnabled).toHaveBeenCalledWith('normal', false)
  })
  it('waits for Save and retains startup differences across catalog reloads', async () => {
    const { api, controller, controls } = fixture()
    await controls.list()
    await controls.setEnabled('normal' as never, false)
    expect(api.setEnabled).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().dirtyNative).toEqual(['normal'])
    await controller.save()
    await controls.list()
    expect(controller.store.getSnapshot()).toMatchObject({ dirtyNative: [], changedNative: ['normal'], error: null })
    const reopened = new PluginInventoryController(api)
    await reopened.nativePlugins!.list()
    expect(reopened.store.getSnapshot().changedNative).toEqual(['normal'])
    await controls.setEnabled('normal' as never, true)
    expect(controller.store.getSnapshot().changedNative).toEqual([])
    controller.discard()
    await controls.list()
    expect(controller.store.getSnapshot().changedNative).toEqual(['normal'])
  })

  it('marks a staged core change as restart-required before Save', async () => {
    const { controls } = fixture()
    await controls.list()
    await controls.setEnabled('core' as never, false)

    expect((await controls.list()).entries[0]).toMatchObject({ pendingEnabled: false, restartRequired: true })
  })

  it('retains failed edits and retries only the unsaved part of a mixed batch', async () => {
    const { api, controller, controls } = fixture()
    await controls.list()
    await controls.setEnabled('core' as never, false)
    await controls.setEnabled('normal' as never, false)
    const setEnabled = api.setEnabled
    api.setEnabled = vi.fn<NativePluginControls['setEnabled']>(async (id, enabled) => {
      if (id === 'normal') throw new Error('disk full')
      return setEnabled(id, enabled)
    })
    await controller.save()
    expect(controller.store.getSnapshot()).toMatchObject({ dirtyNative: ['normal'], changedNative: ['core', 'normal'], error: 'disk full' })
    expect((await controls.list()).entries[0]).toMatchObject({ enabled: true, pendingEnabled: false, restartRequired: true })
    api.setEnabled = setEnabled
    await controller.save()
    expect(controller.store.getSnapshot()).toMatchObject({ dirtyNative: [], changedNative: ['core', 'normal'], error: null })
    expect(setEnabled).toHaveBeenCalledTimes(2)
  })

  it('ignores stale reads and repeat saves while a commit is pending', async () => {
    const { api, controller, controls } = fixture()
    const original = await controls.list()
    let finishRead!: (snapshot: PluginInventorySnapshot) => void
    vi.mocked(api.list).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve }))
    const stale = controls.list()
    await controls.setEnabled('normal' as never, false)
    let finishSave!: () => void
    const setEnabled = api.setEnabled
    api.setEnabled = vi.fn<NativePluginControls['setEnabled']>(async (id, enabled) => {
      await new Promise<void>((resolve) => { finishSave = resolve })
      return setEnabled(id, enabled)
    })
    const saving = controller.save()
    await controller.save()
    await controls.setEnabled('core' as never, false)
    expect(api.setEnabled).toHaveBeenCalledOnce()
    finishSave()
    await saving
    finishRead(original)
    expect((await stale).entries[1]?.enabled).toBe(false)
    expect(controller.store.getSnapshot().changedNative).toEqual(['normal'])
  })

  it('retains drafts across read errors and discards them without writing', async () => {
    const { api, controller, controls } = fixture()
    await controls.list()
    await controls.setEnabled('normal' as never, false)
    vi.mocked(api.list).mockRejectedValueOnce(new Error('offline'))
    await expect(controls.list()).rejects.toThrow('offline')
    expect(controller.store.getSnapshot().dirtyNative).toEqual(['normal'])
    controller.discard()
    expect(controller.store.getSnapshot()).toMatchObject({ dirtyNative: [], changedNative: [] })
    expect(api.setEnabled).not.toHaveBeenCalled()
  })
})
