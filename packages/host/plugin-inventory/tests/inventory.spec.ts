import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber, type Plugin } from '@hydra/cordis'
import Loader, { EntryTree, type EntryOptions } from '@hydra/cordis-plugin-loader'
import Include from '@hydra/cordis-plugin-include'
import { resolveProfileDir } from '@hydra/harness-app-boot'
import { settingsNamespace } from '@hydra/harness-settings'
import FileSettingsProvider from '@hydra/harness-settings-file'
import { remoteMethods } from '@hydra/harness-typert-protocol'
import PluginInventoryGateway from '../src/index.ts'
import type { PluginEntryId } from '../src/types.ts'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function profile(entries: Partial<EntryOptions>[]) {
  const { ctx, inventory, gatewayFiber } = await harness()
  const directory = await mkdtemp(join(tmpdir(), 'hydra-inventory-profile-'))
  tempDirs.push(directory)
  const filename = join(directory, 'cordis.yml')
  await writeFile(filename, JSON.stringify(entries))
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.second = () => {}
  const includeId = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(filename).href } })
  await ctx.loader.await()
  return { ctx, inventory, gatewayFiber, includeId, directory,
    entry: (id: string) => ctx.loader.resolve(`${includeId}:${id}`) }
}

async function harness(): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
  gatewayFiber: Fiber
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const dir = await mkdtemp(join(tmpdir(), 'hydra-plugin-inventory-settings-'))
  tempDirs.push(dir)
  await ctx.plugin(Loader)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  const gatewayFiber = ctx.plugin(PluginInventoryGateway)
  await gatewayFiber
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory, gatewayFiber }
}

describe('PluginInventoryGateway', () => {
  it('projects plugin descriptions and usage from Host and preset metadata', async () => {
    const h = await profile([{ id: 'native', name: 'cordis:active', disabled: true,
      description: 'Fixture description', application: 'Use the fixture.' }])
    h.ctx.provide('agentPresets', {
      listPluginEntries: async () => [{ entryId: 'agent-preset:standard:fixture', presetId: 'standard',
        moduleName: 'cordis:active', enabled: false, description: 'Preset description', application: 'Use the preset.' }],
      setPluginEnabled: async () => {},
    })
    const details = (await h.inventory.list()).entries
    expect(details.find(entry => entry.moduleName === 'cordis:active' && entry.presetId === undefined)).toMatchObject({ description: 'Fixture description', application: 'Use the fixture.' })
    expect(details.find(entry => entry.presetId !== undefined)).toMatchObject({ description: 'Preset description', application: 'Use the preset.' })
  })

  it('reads plugin presentation metadata from its package manifest', async () => {
    const h = await profile([{ id: 'package', name: '@fixture/metadata', disabled: true }])
    const packageDir = join(h.directory, 'node_modules', '@fixture', 'metadata')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: '@fixture/metadata',
      description: 'Fixture package description',
      hydra: { plugin: { application: 'Use the fixture package.' } },
    }))
    expect((await h.inventory.list()).entries.find(entry => entry.moduleName === '@fixture/metadata'))
      .toMatchObject({ description: 'Fixture package description', application: 'Use the fixture package.' })
  })

  it('uses unscoped package metadata and tolerates an absent disabled manifest', async () => {
    const h = await profile([
      { id: 'plain', name: 'plain-metadata', disabled: true },
      { id: 'missing', name: 'missing-metadata', disabled: true },
    ])
    const packageDir = join(h.directory, 'node_modules', 'plain-metadata')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: 'plain-metadata', description: 'Unscoped package description',
    }))
    const entries = (await h.inventory.list()).entries
    expect(entries.find(entry => entry.moduleName === 'plain-metadata'))
      .toMatchObject({ description: 'Unscoped package description' })
    expect(entries.find(entry => entry.moduleName === 'missing-metadata'))
      .not.toHaveProperty('description')
  })

  it('tolerates package manifests hidden by exports and rejects invalid manifests', async () => {
    const h = await profile([
      { id: 'hidden', name: 'hidden-metadata', disabled: true },
      { id: 'invalid', name: 'invalid-package', disabled: true },
    ])
    const hiddenDir = join(h.directory, 'node_modules', 'hidden-metadata')
    await mkdir(hiddenDir, { recursive: true })
    await writeFile(join(hiddenDir, 'package.json'), JSON.stringify({
      name: 'hidden-metadata', exports: { '.': './index.js' },
    }))
    const invalidDir = join(h.directory, 'node_modules', 'invalid-package')
    await mkdir(invalidDir, { recursive: true })
    await writeFile(join(invalidDir, 'package.json'), '{')
    await expect(h.inventory.list()).rejects.toMatchObject({ code: 'ERR_INVALID_PACKAGE_CONFIG' })
  })

  it('uses application metadata when a package has no description', async () => {
    const h = await profile([{ id: 'application', name: 'application-metadata', disabled: true }])
    const packageDir = join(h.directory, 'node_modules', 'application-metadata')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: 'application-metadata', hydra: { plugin: { application: 'Use this fixture.' } },
    }))
    expect((await h.inventory.list()).entries.find(entry => entry.moduleName === 'application-metadata'))
      .toMatchObject({ application: 'Use this fixture.' })
  })

  it('rejects malformed package metadata instead of exposing partial presentation data', async () => {
    const h = await profile([{ id: 'invalid', name: 'invalid-metadata', disabled: true }])
    const packageDir = join(h.directory, 'node_modules', 'invalid-metadata')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'invalid-metadata', description: 42 }))
    await expect(h.inventory.list()).rejects.toThrow('invalid plugin metadata')
  })

  it.each([1, 2])('reports %s failures while applying changed plugin settings', async (count) => {
    const h = await profile([{ id: 'one', name: 'cordis:active' }, { id: 'two', name: 'cordis:second' }])
    await h.gatewayFiber.dispose()
    await h.ctx.plugin(PluginInventoryGateway).await()
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(h.entry('one'), 'update').mockRejectedValueOnce(new Error('first unload failed'))
    if (count === 2) vi.spyOn(h.entry('two'), 'update').mockRejectedValueOnce(new Error('second unload failed'))
    await h.ctx.settings.update(settingsNamespace('plugins'), { enabled: { 'cordis:active': false, 'cordis:second': false } })
    await vi.waitFor(() => {
      const error = warn.mock.calls.flat().find(value => value instanceof Error)
      expect(error?.message).toContain(count === 1 ? 'first unload failed' : 'failed to apply plugin settings')
    })
  })

  it('restores defaults after a persisted switch is removed and applies switches for newly added entries', async () => {
    const h = await profile([{ id: 'one', name: 'cordis:active' }])
    await h.gatewayFiber.dispose()
    await h.ctx.plugin(PluginInventoryGateway).await()
    const settings = h.ctx.settings
    const external = await h.ctx.loader.create({ name: 'cordis:pending' })
    await settings.update(settingsNamespace('plugins'), { enabled: { 'cordis:active': false, 'cordis:pending': false, missing: false } })
    expect(h.entry('one').disabled).toBe(true)
    expect(h.ctx.loader.resolve(external).disabled).toBe(false)
    await settings.replace(settingsNamespace('plugins'), { enabled: {} })
    expect(h.entry('one').disabled).toBe(false)
    const lateId = await h.ctx.loader.create({ name: 'cordis:second' }, h.includeId)
    await settings.update(settingsNamespace('plugins'), { enabled: { 'cordis:second': false } })
    await settings.replace(settingsNamespace('plugins'), { enabled: {} })
    expect(h.ctx.loader.resolve(lateId).disabled).toBe(true)
  })

  it('prefers the restart-only representative for duplicate modules outside a profile', async () => {
    const { ctx, inventory } = await harness()
    await ctx.loader.create({ name: 'cordis:active' })
    const core = await ctx.loader.create({ name: 'cordis:active', pluginType: 'core' })
    expect((await inventory.list()).entries.find(entry => entry.moduleName === 'cordis:active')?.entryId).toBe(core)
  })

  it('rejects missing preset controls and preserves preset no-ops before the first listing', async () => {
    const { ctx, inventory } = await harness()
    const entryId = 'agent-preset:standard:tool' as PluginEntryId
    await expect(inventory.setEnabled({ entryId, enabled: false })).rejects.toThrow('unavailable')
    const presets = { listPluginEntries: vi.fn(async () => [{ entryId, presetId: 'standard', moduleName: 'tool', enabled: true }]),
      setPluginEnabled: vi.fn(async () => {}) }
    ctx.provide('agentPresets', presets)
    await inventory.setEnabled({ entryId, enabled: true })
    expect(presets.setPluginEnabled).not.toHaveBeenCalled()
    await expect(inventory.setEnabled({ entryId: 'agent-preset:missing' as PluginEntryId, enabled: false }))
      .rejects.toThrow('cannot be toggled')
  })

  it('reports mixed grouped defaults and retains no-op switches', async () => {
    const h = await profile([
      { id: 'one', name: 'cordis:active', pluginGroup: 'pair' },
      { id: 'two', name: 'cordis:second', pluginGroup: 'pair', disabled: true },
    ])
    const row = (await h.inventory.list()).entries.find(entry => entry.moduleName === 'cordis:active')!
    expect(row).toMatchObject({ initialEnabled: null, mixedEnabled: true })
    await h.inventory.setEnabled({ entryId: row.entryId, enabled: true })
    expect(h.entry('two').disabled).toBe(false)
    const update = vi.spyOn(h.entry('one'), 'update')
    await h.inventory.setEnabled({ entryId: row.entryId, enabled: true })
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps the first of duplicate profile entries and restores a never-enabled entry after a save error', async () => {
    const h = await profile([{ id: 'one', name: 'cordis:active', disabled: true },
      { id: 'two', name: 'cordis:active', disabled: true }])
    const row = (await h.inventory.list()).entries.find(entry => entry.moduleName === 'cordis:active')!
    expect(row.entryId).toBe(h.entry('one').id)
    vi.spyOn(h.ctx.settings, 'update').mockRejectedValueOnce(new Error('disk full'))
    await expect(h.inventory.setEnabled({ entryId: row.entryId, enabled: true })).rejects.toThrow('disk full')
    expect(h.entry('one').disabled).toBe(true)
    expect(h.entry('two').disabled).toBe(true)
  })

  it('prefers an editable member when a related module was mounted outside the profile', async () => {
    const { ctx, inventory } = await harness()
    await ctx.loader.create({ name: 'cordis:pending', pluginGroup: 'pair' })
    const directory = await mkdtemp(join(tmpdir(), 'hydra-inventory-group-'))
    tempDirs.push(directory)
    const filename = join(directory, 'cordis.yml')
    await writeFile(filename, JSON.stringify([{ id: 'active', name: 'cordis:active', pluginGroup: 'pair' }]))
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(filename).href } })
    await ctx.loader.await()
    expect((await inventory.list()).entries.find(entry => entry.moduleName === 'cordis:active'))
      .toMatchObject({ toggleable: true, relatedModules: ['cordis:pending'] })
  })

  it('rejects restart-only updates outside a managed profile', async () => {
    const h = await profile([{ id: 'one', name: 'cordis:active', pluginType: 'core' }])
    await expect(h.inventory.setEnabled({ entryId: h.entry('one').id as PluginEntryId, enabled: false }))
      .rejects.toThrow('not a managed hydra profile')
    expect(h.entry('one').disabled).toBe(false)
  })

  it('restores entries when persistence fails and reports rollback failure separately', async () => {
    const h = await profile([{ id: 'one', name: 'cordis:active' }])
    const request = { entryId: h.entry('one').id as PluginEntryId, enabled: false }
    vi.spyOn(h.ctx.settings, 'update').mockRejectedValue(new Error('disk full'))
    await expect(h.inventory.setEnabled(request)).rejects.toThrow('disk full')
    expect(h.entry('one').disabled).toBe(false)
    const original = h.entry('one').update.bind(h.entry('one'))
    vi.spyOn(h.entry('one'), 'update').mockImplementationOnce(original).mockRejectedValueOnce(new Error('rollback failed'))
    await expect(h.inventory.setEnabled(request)).rejects.toThrow('failed to persist and roll back')
  })

  it('reports both update and rollback failures while leaving the mutation queue usable', async () => {
    const h = await profile([{ id: 'one', name: 'cordis:active' }])
    const update = vi.spyOn(h.entry('one'), 'update').mockRejectedValue(new Error('unload failed'))
    const request = { entryId: h.entry('one').id as PluginEntryId, enabled: false }
    await expect(h.inventory.setEnabled(request)).rejects.toThrow('failed to update and roll back')
    update.mockRestore()
    await expect(h.inventory.setEnabled(request)).resolves.toMatchObject({ restartRequired: false })
  })

  it.each([false, true])('keeps disabled HMR watch-only with initial roots %s', async (watchOnly) => {
    // oxlint-disable-next-line typescript/unbound-method -- The spy calls this implementation with the original EntryTree receiver.
    const original = EntryTree.prototype.import
    vi.spyOn(EntryTree.prototype, 'import').mockImplementation(function (this: EntryTree, name, stack) {
      return name === '@hydra/cordis-plugin-hmr' ? activePlugin : original.call(this, name, stack) as unknown
    })
    const h = await profile([{ id: 'hmr', name: '@hydra/cordis-plugin-hmr', config: watchOnly ? { root: [] } : {} }])
    await h.gatewayFiber.dispose()
    await h.ctx.plugin(PluginInventoryGateway).await()
    const inventory = h.ctx.get('pluginInventory') as PluginInventoryGateway
    const entryId = h.entry('hmr').id as PluginEntryId
    await inventory.setEnabled({ entryId, enabled: true })
    await inventory.setEnabled({ entryId, enabled: false })
    expect(h.entry('hmr').options.config).toEqual({ root: [] })
    await inventory.setEnabled({ entryId, enabled: true })
    expect(h.entry('hmr').options.config).toEqual({})
    expect(h.entry('hmr').disabled).toBe(false)
  })

  it('rejects invalid lifecycle declarations before exposing plugin controls', async () => {
    for (const metadata of [{ pluginType: 'critical' }, { pluginGroup: '' }, { plugin_type: 'core' }]) {
      const { ctx, inventory } = await harness()
      const options = { name: 'cordis:active', ...metadata }
      await ctx.loader.create(options as Parameters<typeof ctx.loader.create>[0])
      await expect(inventory.list()).rejects.toThrow(/pluginType|pluginGroup|plugin_type/)
    }
  })
  it('publishes list and enablement methods under the pluginInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'pluginInventory',
      namespace: 'pluginInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
      { method: 'listMarketplaces', invocation: { kind: 'direct' } },
      { method: 'addMarketplace', invocation: { kind: 'direct' } },
      { method: 'setMarketplaceEnabled', invocation: { kind: 'direct' } },
      { method: 'removeMarketplace', invocation: { kind: 'direct' } },
      { method: 'listImportedPlugins', invocation: { kind: 'direct' } },
      { method: 'importPlugin', invocation: { kind: 'direct' } },
      { method: 'infoPlugin', invocation: { kind: 'direct' } },
      { method: 'enablePlugin', invocation: { kind: 'direct' } },
      { method: 'disablePlugin', invocation: { kind: 'direct' } },
      { method: 'setPluginMcpServerEnabled', invocation: { kind: 'direct' } },
      { method: 'trustPlugin', invocation: { kind: 'direct' } },
      { method: 'untrustPlugin', invocation: { kind: 'direct' } },
      { method: 'removePlugin', invocation: { kind: 'direct' } },
      { method: 'listMcpServers', invocation: { kind: 'direct' } },
      { method: 'defineMcpServer', invocation: { kind: 'direct' } },
      { method: 'setMcpServerEnabled', invocation: { kind: 'direct' } },
      { method: 'removeMcpServer', invocation: { kind: 'direct' } },
      { method: 'listHookRecords', invocation: { kind: 'direct' } },
      { method: 'defineHookRecord', invocation: { kind: 'direct' } },
      { method: 'setHookRecordEnabled', invocation: { kind: 'direct' } },
      { method: 'removeHookRecord', invocation: { kind: 'direct' } },
    ])
  })

  it('projects current non-group Loader entries without a second cache', async () => {
    const { ctx, inventory } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const snapshot = await inventory.list()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        pluginType: 'normal',
        initialEnabled: true,
        changedSinceStart: false,
        enabled: true,
        restartRequired: false,
        toggleable: false,
        fiberPhase: 'active',
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        pluginType: 'normal',
        initialEnabled: true,
        changedSinceStart: false,
        enabled: true,
        restartRequired: false,
        toggleable: false,
        fiberPhase: 'pending',
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        pluginType: 'normal',
        initialEnabled: false,
        changedSinceStart: false,
        enabled: false,
        restartRequired: false,
        toggleable: false,
        fiberPhase: null,
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect((await inventory.list()).entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      pluginType: 'normal',
      initialEnabled: true,
      changedSinceStart: true,
      enabled: false,
      restartRequired: false,
      toggleable: false,
      fiberPhase: null,
    })

    await ctx.loader.remove(pendingId)
    expect((await inventory.list()).entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('toggles profile entries live and persists protected core state for restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hydra-plugin-inventory-'))
    tempDirs.push(dir)
    const home = join(dir, 'home')
    vi.stubEnv('HYDRA_HOME', home)
    const profileDir = resolveProfileDir('test', home)
    await mkdir(profileDir, { recursive: true })
    const configPath = join(profileDir, 'cordis.yml')
    const settingsPath = join(profileDir, 'settings.yaml')
    await writeFile(configPath, [
      '- id: protected',
      '  name: cordis:protected',
      '  pluginType: core',
      '  pluginGroup: platform',
      '- id: companion',
      '  name: cordis:companion',
      '  pluginGroup: platform',
      '- id: mutable',
      '  name: cordis:active',
      '  pluginGroup: normal-pair',
      '- id: normal-peer',
      '  name: cordis:normal-peer',
      '  pluginGroup: normal-pair',
      '- id: inventory',
      '  name: cordis:inventory',
      '  pluginType: core',
      '',
    ].join('\n'))
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'test', hydra: { profile: {} } }))
    await writeFile(settingsPath, '# keep this user comment\n{}\n')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.active = activePlugin
    ctx.loader.builtins.inventory = PluginInventoryGateway
    ctx.loader.builtins.protected = activePlugin
    ctx.loader.builtins.companion = activePlugin
    ctx.loader.builtins['normal-peer'] = activePlugin
    const includeId = await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
    const snapshot = await inventory.list()
    const mutableId = `${includeId}:mutable`
    const protectedId = `${includeId}:protected`
    const mutable = snapshot.entries.find(entry => entry.entryId === mutableId)!
    const protectedEntry = snapshot.entries.find(entry => entry.entryId === protectedId)!
    expect(mutable.toggleable).toBe(true)
    expect(protectedEntry.toggleable).toBe(true)
    expect(protectedEntry.enabled).toBe(true)
    expect(protectedEntry.relatedModules).toEqual(['cordis:companion'])
    expect(snapshot.entries.some(entry => entry.moduleName === 'cordis:companion')).toBe(false)
    expect(protectedEntry.restartRequired).toBe(false)
    expect(protectedEntry.fiberPhase).toBe('active')

    const coreChanged = await inventory.setEnabled({ entryId: protectedEntry.entryId, enabled: false })
    expect(coreChanged.restartRequired).toBe(true)
    expect(coreChanged.snapshot.entries.find(entry => entry.entryId === protectedId)?.changedSinceStart).toBe(true)
    expect(ctx.loader.resolve(protectedId).disabled).toBe(false)
    expect(ctx.loader.resolve(`${includeId}:companion`).disabled).toBe(false)
    expect((await inventory.list()).entries.find(entry => entry.entryId === protectedEntry.entryId)).toMatchObject({
      enabled: true,
      pendingEnabled: false,
      restartRequired: true,
    })
    expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))).toMatchObject({
      hydra: { profile: { pluginEnablement: { protected: false, companion: false } } },
    })

    await inventory.setEnabled({ entryId: mutable.entryId, enabled: false })
    expect((await inventory.list()).entries.find(entry => entry.entryId === mutable.entryId)).toMatchObject({
      enabled: false,
      fiberPhase: null,
    })
    const disabledSettings = await readFile(settingsPath, 'utf8')
    expect(disabledSettings).toContain('# keep this user comment')
    expect(disabledSettings).toContain('plugins:')
    expect(ctx.settings.get(settingsNamespace('plugins'))).toMatchObject({ enabled: { 'cordis:active': false } })

    await inventory.setEnabled({ entryId: mutable.entryId, enabled: true })
    const persisted = await readFile(settingsPath, 'utf8')
    expect(persisted).toContain('# keep this user comment')
    expect(persisted.match(/cordis:active/g)).toHaveLength(1)
    expect(ctx.settings.get(settingsNamespace('plugins'))).toMatchObject({ enabled: { 'cordis:active': true } })
    const peer = ctx.loader.resolve(`${includeId}:normal-peer`)
    expect(peer.disabled).toBe(false)
    vi.spyOn(peer, 'update').mockRejectedValueOnce(new Error('unload failed'))
    await expect(inventory.setEnabled({ entryId: mutable.entryId, enabled: false })).rejects.toThrow('unload failed')
    expect(peer.disabled).toBe(false)
    expect(ctx.loader.resolve(mutableId).disabled).toBe(false)
    expect(ctx.settings.get(settingsNamespace('plugins'))).toEqual({ enabled: { 'cordis:active': true, 'cordis:normal-peer': true } })
    const coreRestored = await inventory.setEnabled({ entryId: protectedEntry.entryId, enabled: true })
    expect(coreRestored.restartRequired).toBe(false)
    expect(coreRestored.snapshot.entries.find(entry => entry.entryId === protectedId)?.changedSinceStart).toBe(false)
    expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))).toMatchObject({
      hydra: { profile: { pluginEnablement: { protected: true } } },
    })
    await expect(inventory.setEnabled({
      entryId: `${includeId}:missing` as PluginEntryId,
      enabled: false,
    })).rejects.toThrow(`cannot resolve entry ${includeId}:missing`)
  })

  it('projects preset leaf entries and delegates their switches', async () => {
    const { ctx, inventory } = await harness()
    let enabled = true
    const presets = {
      listPluginEntries: vi.fn(async () => [{
        entryId: 'agent-preset:standard:tool-subagent',
        presetId: 'standard',
        moduleName: '@hydra/harness-tool-subagent',
        enabled,
      }]),
      setPluginEnabled: vi.fn(async (_entryId: string, next: boolean) => { enabled = next }),
    }
    ctx.provide('agentPresets', presets)

    const entry = (await inventory.list()).entries.find(candidate => candidate.presetId === 'standard')!
    expect(entry).toMatchObject({
      entryId: 'agent-preset:standard:tool-subagent',
      moduleName: '@hydra/harness-tool-subagent',
      enabled: true,
      newSessionsOnly: true,
      restartRequired: false,
      toggleable: true,
      fiberPhase: null,
    })

    const result = await inventory.setEnabled({ entryId: entry.entryId, enabled: false })
    expect(presets.setPluginEnabled).toHaveBeenCalledWith('agent-preset:standard:tool-subagent', false)
    expect(result.restartRequired).toBe(false)
    expect(result.snapshot.entries.find(candidate => candidate.entryId === entry.entryId)).toMatchObject({
      enabled: false,
      newSessionsOnly: true,
    })
  })

  it('ignores persisted switches for entries owned by another composition plane', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hydra-plugin-inventory-composition-'))
    tempDirs.push(dir)
    const configPath = join(dir, 'cordis.yml')
    const settingsPath = join(dir, 'settings.yaml')
    await writeFile(configPath, [
      '- id: preset-only',
      '  name: cordis:pending',
      '  disabled: true',
      '- id: inventory',
      '  name: cordis:inventory',
      '  config:',
      '    compositionEntryIds: [preset-only]',
      '',
    ].join('\n'))
    await writeFile(settingsPath, [
      'plugins:',
      '  enabled:',
      '    cordis:pending: true',
      '',
    ].join('\n'))

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.inventory = PluginInventoryGateway
    ctx.loader.builtins.pending = pendingPlugin
    const includeId = await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
    const presetOnlyId = `${includeId}:preset-only` as PluginEntryId

    expect(ctx.loader.resolve(presetOnlyId).disabled).toBe(true)
    expect((await inventory.list()).entries.some(entry => entry.moduleName === 'cordis:pending')).toBe(false)
    await expect(inventory.setEnabled({ entryId: presetOnlyId, enabled: true }))
      .rejects.toThrow('cannot be toggled in-app')
  })

  it('deduplicates a module and hands its shared setting to the configured entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hydra-plugin-inventory-duplicate-'))
    tempDirs.push(dir)
    const configPath = join(dir, 'cordis.yml')
    const settingsPath = join(dir, 'settings.yaml')
    await writeFile(configPath, [
      '- id: disabled',
      '  name: cordis:active',
      '  disabled: true',
      '',
    ].join('\n'))
    await writeFile(settingsPath, '{}\n')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.active = activePlugin
    const includeId = await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    const duplicateId = await ctx.loader.create({ name: 'cordis:active' })
    await ctx.loader.await()
    await ctx.plugin(PluginInventoryGateway)
    const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
    const entryId = `${includeId}:disabled` as PluginEntryId

    expect((await inventory.list()).entries.filter(entry => entry.moduleName === 'cordis:active')).toEqual([expect.objectContaining({
      entryId,
      enabled: false,
      toggleable: true,
    })])

    await inventory.setEnabled({ entryId, enabled: true })
    expect(ctx.loader.resolve(entryId).disabled).toBe(false)
    expect(ctx.loader.resolve(duplicateId).disabled).toBe(true)
    expect(ctx.settings.get(settingsNamespace('plugins'))).toMatchObject({ enabled: { 'cordis:active': true } })

    await inventory.setEnabled({ entryId, enabled: false })
    expect(ctx.loader.resolve(entryId).disabled).toBe(true)
    expect(ctx.loader.resolve(duplicateId).disabled).toBe(true)
    expect(ctx.settings.get(settingsNamespace('plugins'))).toMatchObject({ enabled: { 'cordis:active': false } })

    await ctx.settings.update(settingsNamespace('plugins'), { enabled: { 'cordis:active': true } })
    await vi.waitFor(() => { expect(ctx.loader.resolve(entryId).disabled).toBe(false) })
    expect(ctx.loader.resolve(duplicateId).disabled).toBe(true)
  })
})
