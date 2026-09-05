import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Plugin } from '@bosch/cordis'
import Loader from '@bosch/cordis-plugin-loader'
import Include from '@bosch/cordis-plugin-include'
import { resolveProfileDir } from '@bosch/bh-app-boot'
import { settingsNamespace } from '@bosch/bh-settings'
import FileSettingsProvider from '@bosch/bh-settings-file'
import { remoteMethods } from '@bosch/bh-typert-protocol'
import PluginInventoryGateway from '../src/index.ts'
import type { PluginEntryId } from '../src/types.ts'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function harness(): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const dir = await mkdtemp(join(tmpdir(), 'bh-plugin-inventory-settings-'))
  tempDirs.push(dir)
  await ctx.plugin(Loader)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  await ctx.plugin(PluginInventoryGateway)
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory }
}

describe('PluginInventoryGateway', () => {
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
        enabled: true,
        restartRequired: false,
        toggleable: false,
        fiberPhase: 'active',
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        restartRequired: false,
        toggleable: false,
        fiberPhase: 'pending',
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
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
      enabled: false,
      restartRequired: false,
      toggleable: false,
      fiberPhase: null,
    })

    await ctx.loader.remove(pendingId)
    expect((await inventory.list()).entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('toggles profile entries live and persists protected core state for restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bh-plugin-inventory-'))
    tempDirs.push(dir)
    const home = join(dir, 'home')
    vi.stubEnv('BH_HOME', home)
    const profileDir = resolveProfileDir('test', home)
    await mkdir(profileDir, { recursive: true })
    const configPath = join(profileDir, 'cordis.yml')
    const settingsPath = join(profileDir, 'settings.yaml')
    await writeFile(configPath, [
      '- id: protected',
      '  name: cordis:protected',
      '- id: mutable',
      '  name: cordis:active',
      '- id: inventory',
      '  name: cordis:inventory',
      '  config:',
      '    protectedEntryIds: [protected, inventory]',
      '',
    ].join('\n'))
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'test', bh: { profile: {} } }))
    await writeFile(settingsPath, '# keep this user comment\n{}\n')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.active = activePlugin
    ctx.loader.builtins.inventory = PluginInventoryGateway
    ctx.loader.builtins.protected = activePlugin
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
    expect(protectedEntry.restartRequired).toBe(false)
    expect(protectedEntry.fiberPhase).toBe('active')

    const coreChanged = await inventory.setEnabled({ entryId: protectedEntry.entryId, enabled: false })
    expect(coreChanged.restartRequired).toBe(true)
    expect(ctx.loader.resolve(protectedId).disabled).toBe(false)
    expect((await inventory.list()).entries.find(entry => entry.entryId === protectedEntry.entryId)).toMatchObject({
      enabled: true,
      pendingEnabled: false,
      restartRequired: true,
    })
    expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))).toMatchObject({
      bh: { profile: { pluginEnablement: { protected: false } } },
    })

    await inventory.setEnabled({ entryId: mutable.entryId, enabled: false })
    expect((await inventory.list()).entries.find(entry => entry.entryId === mutable.entryId)).toMatchObject({
      enabled: false,
      fiberPhase: null,
    })
    const disabledSettings = await readFile(settingsPath, 'utf8')
    expect(disabledSettings).toContain('# keep this user comment')
    expect(disabledSettings).toContain('plugins:')
    expect(ctx.settings.get(settingsNamespace('plugins'))).toEqual({ enabled: { 'cordis:active': false } })

    await inventory.setEnabled({ entryId: mutable.entryId, enabled: true })
    const persisted = await readFile(settingsPath, 'utf8')
    expect(persisted).toContain('# keep this user comment')
    expect(persisted.match(/cordis:active/g)).toHaveLength(1)
    expect(ctx.settings.get(settingsNamespace('plugins'))).toEqual({ enabled: { 'cordis:active': true } })
    const coreRestored = await inventory.setEnabled({ entryId: protectedEntry.entryId, enabled: true })
    expect(coreRestored.restartRequired).toBe(false)
    expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))).toMatchObject({
      bh: { profile: { pluginEnablement: { protected: true } } },
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
        moduleName: '@bosch/bh-tool-subagent',
        enabled,
      }]),
      setPluginEnabled: vi.fn(async (_entryId: string, next: boolean) => { enabled = next }),
    }
    ctx.provide('agentPresets', presets)

    const entry = (await inventory.list()).entries.find(candidate => candidate.presetId === 'standard')!
    expect(entry).toMatchObject({
      entryId: 'agent-preset:standard:tool-subagent',
      moduleName: '@bosch/bh-tool-subagent',
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
    const dir = await mkdtemp(join(tmpdir(), 'bh-plugin-inventory-composition-'))
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
    const dir = await mkdtemp(join(tmpdir(), 'bh-plugin-inventory-duplicate-'))
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
    expect(ctx.settings.get(settingsNamespace('plugins'))).toEqual({ enabled: { 'cordis:active': true } })

    await inventory.setEnabled({ entryId, enabled: false })
    expect(ctx.loader.resolve(entryId).disabled).toBe(true)
    expect(ctx.loader.resolve(duplicateId).disabled).toBe(true)
    expect(ctx.settings.get(settingsNamespace('plugins'))).toEqual({ enabled: { 'cordis:active': false } })

    await ctx.settings.update(settingsNamespace('plugins'), { enabled: { 'cordis:active': true } })
    await vi.waitFor(() => { expect(ctx.loader.resolve(entryId).disabled).toBe(false) })
    expect(ctx.loader.resolve(duplicateId).disabled).toBe(true)
  })
})
