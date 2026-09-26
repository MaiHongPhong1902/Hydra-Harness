import { describe, expect, it, vi } from 'vitest'
import type { ImportedPluginSnapshot, PluginInventorySnapshot } from '@hydra1902/harness-api-remotes/client'
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
  it('saves imported enablement and disablement while retaining the app-start comparison', async () => {
    const b = importedFixture()
    const original = await b.controls.list()
    const { initialEnabled: _initial, ...legacy } = original.plugins[0]!
    vi.mocked(b.api.list).mockResolvedValue({ plugins: [legacy] })
    await b.controls.list()
    await b.controls.enable('missing')
    await b.controls.enable(b.identity)
    await b.controls.disable(b.identity)
    expect(b.controller.hasPendingImportedChanges()).toBe(false)
    await b.controls.enable(b.identity)
    vi.mocked(b.api.enable).mockResolvedValue({ plugins: [{ ...legacy, enabled: true }] })
    await b.controller.save()
    expect(b.controller.store.getSnapshot()).toMatchObject({ dirtyImported: [], changedImported: [b.identity] })
    await b.controls.disable(b.identity)
    vi.mocked(b.api.disable).mockResolvedValue({ plugins: [legacy] })
    await b.controller.save()
    expect(b.api.disable).toHaveBeenCalledWith(b.identity)
    expect(b.controller.store.getSnapshot().changedImported).toEqual([])
    b.controller.dispose()
    await b.controls.enable(b.identity)
    b.controller.discard()
    await b.controller.save()
    expect(b.controller.hasPendingImportedChanges()).toBe(false)
  })

  it('drops drafts removed by refreshed catalogs and ignores unknown native rows', async () => {
    const native = fixture()
    const imported = importedFixture()
    const initial = await native.controls.list()
    vi.mocked(native.api.list).mockResolvedValue({ entries: initial.entries.map(({ initialEnabled: _initial, ...entry }) => entry) })
    await native.controls.list()
    await native.controls.setEnabled('missing' as never, false)
    await native.controls.setEnabled('normal' as never, false)
    await native.controls.setEnabled('normal' as never, true)
    expect(native.controller.store.getSnapshot().dirtyNative).toEqual([])
    await native.controls.setEnabled('normal' as never, false)
    vi.mocked(native.api.list).mockResolvedValue({ entries: [] })
    await native.controls.list()
    expect(native.controller.store.getSnapshot().dirtyNative).toEqual([])
    await imported.controls.list()
    await imported.controls.enable(imported.identity)
    vi.mocked(imported.api.list).mockResolvedValue({ plugins: [] })
    await imported.controls.list()
    expect(imported.controller.store.getSnapshot().dirtyImported).toEqual([])
  })

  it('clears drafts once another editor saves the same enablement', async () => {
    const native = fixture()
    const imported = importedFixture()
    const n = await native.controls.list()
    const i = await imported.controls.list()
    await native.controls.setEnabled('normal' as never, false)
    await imported.controls.enable(imported.identity)
    await imported.controls.list()
    expect(imported.controller.hasPendingImportedChanges()).toBe(true)
    vi.mocked(native.api.list).mockResolvedValue({ entries: n.entries.map(entry => ({ ...entry, enabled: false })) })
    vi.mocked(imported.api.list).mockResolvedValue({ plugins: i.plugins.map(plugin => ({ ...plugin, enabled: true })) })
    await native.controls.list()
    await imported.controls.list()
    expect(native.controller.store.getSnapshot().dirtyNative).toEqual([])
    expect(imported.controller.store.getSnapshot().dirtyImported).toEqual([])
  })

  it.each([false, true])('drops a native write response after disposal (reject: %s)', async (reject) => {
    const b = fixture()
    const initial = await b.controls.list()
    const pending = Promise.withResolvers<Awaited<ReturnType<NativePluginControls['setEnabled']>>>()
    vi.mocked(b.api.setEnabled).mockReturnValue(pending.promise)
    await b.controls.setEnabled('normal' as never, false)
    const saving = b.controller.save()
    b.controller.discard()
    b.controller.dispose()
    await b.controls.setEnabled('core' as never, false)
    if (reject) pending.reject('closed')
    else pending.resolve({ snapshot: initial, restartRequired: false })
    await saving
    expect(b.controller.store.getSnapshot()).toMatchObject({ saving: true, error: null, dirtyNative: ['normal'] })
  })

  it.each(['save', 'remove'] as const)('ignores imported responses after disposal: %s', async (operation) => {
    const b = importedFixture()
    const initial = await b.controls.list()
    const pending = Promise.withResolvers<ImportedPluginSnapshot>()
    vi.mocked(b.api.enable).mockReturnValue(pending.promise)
    vi.mocked(b.api.remove).mockReturnValue(pending.promise)
    await b.controls.enable(b.identity)
    const saving = operation === 'save' ? b.controller.save() : b.controls.remove(b.identity)
    await b.controls.disable(b.identity)
    await b.controls.remove(b.identity)
    b.controller.dispose()
    pending.resolve({ plugins: [] })
    await saving
    expect((await b.controls.list()).plugins).toEqual(initial.plugins.map(plugin => ({ ...plugin, enabled: true })))
    expect(b.controller.store.getSnapshot().saving).toBe(true)
  })

  it('retains imported drafts on non-Error failures', async () => {
    const b = importedFixture()
    await b.controls.list()
    await b.controls.enable(b.identity)
    vi.mocked(b.api.enable).mockRejectedValue('offline')
    await b.controller.save()
    expect(b.controller.store.getSnapshot()).toMatchObject({ error: 'offline', dirtyImported: [b.identity] })
    const empty = new PluginInventoryController()
    await empty.save()
    expect(empty.store.getSnapshot().saving).toBe(false)
  })

  it('ignores older catalog responses even without an intervening save', async () => {
    const native = fixture()
    const imported = importedFixture()
    const oldNative = await native.controls.list()
    const oldImported = await imported.controls.list()
    const n = Promise.withResolvers<PluginInventorySnapshot>()
    const i = Promise.withResolvers<ImportedPluginSnapshot>()
    vi.mocked(native.api.list).mockReturnValueOnce(n.promise).mockResolvedValueOnce({ entries: [] })
    vi.mocked(imported.api.list).mockReturnValueOnce(i.promise).mockResolvedValueOnce({ plugins: [] })
    const nRead = native.controls.list()
    const iRead = imported.controls.list()
    await native.controls.list()
    await imported.controls.list()
    n.resolve(oldNative)
    i.resolve(oldImported)
    expect(await nRead).toEqual({ entries: [] })
    expect(await iRead).toEqual({ plugins: [] })
    native.controller.dispose()
    expect(await native.controls.list()).toEqual({ entries: [] })
  })

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
