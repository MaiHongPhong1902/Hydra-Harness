type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: unknown,
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import Loader from '@hydra/cordis-plugin-loader'
import FileSettingsProvider from '@hydra/harness-settings-file'
import type { ImportedPluginEntry, ImportedPluginIdentity, ImportedPluginRuntime } from '@hydra/harness-plugin-runtime'
import PluginInventoryGateway from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  execFileMock.mockReset()
})

function stubGitMarketplace(): void {
  execFileMock.mockImplementation((command, args, _options, callback) => {
    if (command !== 'git') throw new Error(`unexpected command ${command}`)
    if (!args.includes('clone')) {
      callback(null, '', '')
      return
    }
    const checkout = args.at(-1)
    if (checkout === undefined) throw new Error('clone target missing')
    void mkdir(join(checkout, '.agents', 'plugins'), { recursive: true })
      .then(() => writeFile(join(checkout, '.agents', 'plugins', 'marketplace.json'), '{"plugins":[]}'))
      .then(
        () => { callback(null, '', '') },
        (error: unknown) => { callback(error as Error, '', '') },
      )
  })
}

async function harness(): Promise<{ ctx: Context; inventory: PluginInventoryGateway }> {
  const root = await mkdtemp(join(tmpdir(), 'bh-openai-marketplace-'))
  directories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
  await ctx.plugin(PluginInventoryGateway)
  return { ctx, inventory: ctx.get('pluginInventory') as PluginInventoryGateway }
}

/** Minimal fake `importedPlugins` service: enough for cascade to enable/disable/remove by identity. */
function fakeImportedPluginsRuntime(marketplace: string) {
  const plugins = new Map<string, ImportedPluginEntry>([
    ['demo-plugin@fixture', {
      identity: 'demo-plugin@fixture' as ImportedPluginIdentity,
      name: 'demo-plugin',
      version: '1.0.0',
      source: { kind: 'marketplace-local', source: marketplace, sourceId: 'fixture', marketplace },
      pluginRoot: '/fixture',
      dataPath: '/fixture-data',
      enabled: false,
      lifecycle: 'disabled',
      hookTrustState: 'not-applicable',
      skills: [],
      mcpServers: [],
      hooks: [],
      installationStatus: 'installed',
    }],
  ])
  const snapshot = (): { plugins: ImportedPluginEntry[] } => ({ plugins: [...plugins.values()] })
  const setLifecycle = (identity: string, enabled: boolean): { plugins: ImportedPluginEntry[] } => {
    const entry = plugins.get(identity)
    if (entry !== undefined) plugins.set(identity, { ...entry, enabled, lifecycle: enabled ? 'enabled' : 'disabled' })
    return snapshot()
  }
  return {
    list: vi.fn(async () => snapshot()),
    enable: vi.fn(async (identity: string) => setLifecycle(identity, true)),
    disable: vi.fn(async (identity: string) => setLifecycle(identity, false)),
    remove: vi.fn(async (identity: string) => { plugins.delete(identity); return snapshot() }),
  }
}

describe('OpenAI/Codex marketplace sources', () => {
  it.each([
    { sparsePaths: [], sparseClone: false },
    { sparsePaths: ['plugins/codex'], sparseClone: true },
  ])('keeps the catalog readable with sparse clone $sparseClone', async ({ sparsePaths, sparseClone }) => {
    stubGitMarketplace()
    const { inventory } = await harness()

    await inventory.addMarketplace({ source: 'example/plugins', sparsePaths })

    const cloneCalls = execFileMock.mock.calls.filter(call => call[1].includes('clone'))
    expect(cloneCalls.length).toBeGreaterThan(0)
    expect(cloneCalls.every(call => call[1].includes('--sparse'))).toBe(sparseClone)
    const sparseCalls = execFileMock.mock.calls.filter(call => call[1].includes('sparse-checkout'))
    expect(sparseCalls).toHaveLength(sparseClone ? cloneCalls.length : 0)
    if (sparseClone) expect(sparseCalls[0]?.[1]).toContain('.agents/plugins')
  })

  it('stores a standard marketplace source without treating its entries as Hydra packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bh-openai-marketplace-source-'))
    directories.push(root)
    await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'OpenAI-compatible catalog',
      plugins: [{ name: 'toolkit', source: './toolkit' }],
    }))
    const { inventory } = await harness()

    const added = await inventory.addMarketplace({ source: root })
    expect(added).toEqual({ marketplaces: [{ status: 'ready', source: root, sparsePaths: [], enabled: true }] })
    await expect(inventory.removeMarketplace(root)).resolves.toEqual({ marketplaces: [] })
  })

  it('requires a Codex marketplace document before it persists a source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bh-openai-marketplace-empty-'))
    directories.push(root)
    const { inventory } = await harness()

    await expect(inventory.addMarketplace({ source: root })).rejects.toThrow('OpenAI/Codex marketplace.json is missing')
  })
})

describe('marketplace slot cascade', () => {
  async function harnessWithSource(): Promise<{
    inventory: PluginInventoryGateway
    root: string
    runtime: ReturnType<typeof fakeImportedPluginsRuntime>
  }> {
    const root = await mkdtemp(join(tmpdir(), 'bh-openai-marketplace-cascade-'))
    directories.push(root)
    await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(root, '.agents', 'plugins', 'marketplace.json'), '{"plugins":[]}')
    const { ctx, inventory } = await harness()
    const runtime = fakeImportedPluginsRuntime(root)
    ctx.provide('importedPlugins', runtime as unknown as ImportedPluginRuntime)
    await inventory.addMarketplace({ source: root })
    return { inventory, root, runtime }
  }

  it('cascades enable and disable to plugins imported from the marketplace', async () => {
    const { inventory, root, runtime } = await harnessWithSource()

    const enabled = await inventory.setMarketplaceEnabled({ source: root, enabled: true })
    expect(runtime.enable).toHaveBeenCalledWith('demo-plugin@fixture')
    expect(enabled.marketplaces[0]).toMatchObject({ enabled: true })

    await inventory.setMarketplaceEnabled({ source: root, enabled: false })
    expect(runtime.disable).toHaveBeenCalledWith('demo-plugin@fixture')
  })

  it('uninstalls plugins imported from a marketplace when it is removed', async () => {
    const { inventory, root, runtime } = await harnessWithSource()

    await inventory.removeMarketplace(root)
    expect(runtime.remove).toHaveBeenCalledWith('demo-plugin@fixture')
    expect((await runtime.list()).plugins).toHaveLength(0)
  })

  it('skips the cascade when no imported-plugin runtime is mounted', async () => {
    const { inventory } = await harness()
    const root = await mkdtemp(join(tmpdir(), 'bh-openai-marketplace-no-runtime-'))
    directories.push(root)
    await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(root, '.agents', 'plugins', 'marketplace.json'), '{"plugins":[]}')
    await inventory.addMarketplace({ source: root })

    await expect(inventory.setMarketplaceEnabled({ source: root, enabled: false })).resolves.toBeDefined()
    await expect(inventory.removeMarketplace(root)).resolves.toEqual({ marketplaces: [] })
  })
})
