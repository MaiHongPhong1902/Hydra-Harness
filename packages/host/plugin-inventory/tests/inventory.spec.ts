import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@bosch/cordis'
import Loader from '@bosch/cordis-plugin-loader'
import Include from '@bosch/cordis-plugin-include'
import { remoteMethods } from '@bosch/bh-typert-protocol'
import PluginInventoryGateway from '../src/index.ts'
import type { PluginEntryId } from '../src/types.ts'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
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
  await ctx.plugin(Loader)
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

    const snapshot = inventory.list()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        enabled: true,
        toggleable: false,
        fiberPhase: 'active',
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        toggleable: false,
        fiberPhase: 'pending',
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        enabled: false,
        toggleable: false,
        fiberPhase: null,
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect(inventory.list().entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      enabled: false,
      toggleable: false,
      fiberPhase: null,
    })

    await ctx.loader.remove(pendingId)
    expect(inventory.list().entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('toggles profile entries live and persists only an app-owned patch block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bh-plugin-inventory-'))
    tempDirs.push(dir)
    const configPath = join(dir, 'cordis.yml')
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(configPath, [
      '- id: protected',
      '  name: cordis:active',
      '- id: mutable',
      '  name: cordis:active',
      '',
    ].join('\n'))
    await writeFile(patchPath, '# keep this user comment\n[]\n')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.active = activePlugin
    const includeId = await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    await ctx.plugin(PluginInventoryGateway, { protectedEntryIds: ['protected'] })
    const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
    const snapshot = inventory.list()
    const mutableId = `${includeId}:mutable`
    const protectedId = `${includeId}:protected`
    const mutable = snapshot.entries.find(entry => entry.entryId === mutableId)!
    const protectedEntry = snapshot.entries.find(entry => entry.entryId === protectedId)!
    expect(mutable.toggleable).toBe(true)
    expect(protectedEntry.toggleable).toBe(false)

    await inventory.setEnabled({ entryId: mutable.entryId, enabled: false })
    expect(inventory.list().entries.find(entry => entry.entryId === mutable.entryId)).toMatchObject({
      enabled: false,
      fiberPhase: null,
    })
    expect(await readFile(patchPath, 'utf8')).toBe([
      '# keep this user comment',
      '# BEGIN BH plugin switches',
      '- id: "mutable"',
      '  disabled: true',
      '# END BH plugin switches',
      '',
    ].join('\n'))

    await inventory.setEnabled({ entryId: mutable.entryId, enabled: true })
    const persisted = await readFile(patchPath, 'utf8')
    expect(persisted).toContain('# keep this user comment')
    expect(persisted.match(/- id: "mutable"/g)).toHaveLength(1)
    expect(persisted).toContain('  disabled: false')
    await expect(inventory.setEnabled({
      entryId: protectedEntry.entryId,
      enabled: false,
    })).rejects.toThrow('cannot be toggled in-app')
    await expect(inventory.setEnabled({
      entryId: `${includeId}:missing` as PluginEntryId,
      enabled: false,
    })).rejects.toThrow(`cannot resolve entry ${includeId}:missing`)
  })
})
