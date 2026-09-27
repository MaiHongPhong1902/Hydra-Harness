type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: unknown,
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import Loader from '@hydra/cordis-plugin-loader'
import FileSettingsProvider from '@hydra/harness-settings-file'
import type { ImportedPluginEntry, ImportedPluginIdentity, ImportedPluginRuntime } from '@hydra/harness-plugin-runtime'
import PluginInventoryGateway from '../src/index.ts'
import type { AddPluginMarketplaceRequest } from '../src/types.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: vi.fn(fs.readFile), stat: vi.fn(fs.stat) }
})

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  execFileMock.mockReset()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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
  const root = await mkdtemp(join(tmpdir(), 'hydra-openai-marketplace-'))
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
  it('resolves a remote Git source when its local spelling has a non-directory ancestor', async () => {
    const { inventory } = await harness()
    stubGitMarketplace()
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }))
    await expect(inventory.addMarketplace({ source: 'ssh://git@example.test/owner/repo' })).resolves.toBeDefined()
  })

  it('bounds a marketplace that grows after stat and handles a non-directory ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-marketplace-growth-'))
    directories.push(root)
    const filename = join(root, 'marketplace.json')
    await writeFile(filename, '{"plugins":[]}')
    const { inventory } = await harness()
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.alloc(1024 * 1024 + 1))
    await expect(inventory.addMarketplace({ source: root })).rejects.toThrow('marketplace exceeds')
    await expect(inventory.addMarketplace({ source: join(filename, 'nested') })).rejects.toThrow('pluginInventory:')
  })

  it('forwards imported bundle, MCP and hook controls to their owning optional services', async () => {
    const { ctx, inventory } = await harness()
    expect(() => inventory.listImportedPlugins()).toThrow('runtime is unavailable')
    expect(() => inventory.listMcpServers()).toThrow('registry is unavailable')
    expect(() => inventory.listHookRecords()).toThrow('registry is unavailable')
    const runtime = fakeImportedPluginsRuntime('market')
    const snapshot = await runtime.list()
    const imported = { ...runtime, import: vi.fn(async () => snapshot), info: vi.fn(async () => snapshot.plugins[0]!),
      setMcpServerEnabled: vi.fn(async () => snapshot), setMcpToolApproval: vi.fn(async () => snapshot),
      trustHooks: vi.fn(async () => snapshot), untrustHooks: vi.fn(async () => snapshot) }
    const mcp = { list: vi.fn(() => ({ servers: [] })), define: vi.fn(async () => ({ servers: [] })),
      setEnabled: vi.fn(async () => ({ servers: [] })), remove: vi.fn(async () => ({ servers: [] })) }
    const hooks = { list: vi.fn(() => ({ records: [] })), define: vi.fn(async () => ({ records: [] })),
      setEnabled: vi.fn(async () => ({ records: [] })), remove: vi.fn(async () => ({ records: [] })) }
    ctx.provide('importedPlugins', imported as unknown as ImportedPluginRuntime)
    ctx.provide('mcpServers', mcp as never)
    ctx.provide('hookRecords', hooks as never)
    const server = { mode: 'create', name: 'server', transport: 'stdio', command: 'node' } as const
    const hook = { mode: 'create', name: 'hook', dialect: 'claude-code', config: { hooks: {} } } as const
    const calls = [
      [() => inventory.listImportedPlugins(), imported.list, []],
      [() => inventory.importPlugin('owner/repo'), imported.import, ['owner/repo']],
      [() => inventory.infoPlugin('plugin'), imported.info, ['plugin']],
      [() => inventory.enablePlugin('plugin'), imported.enable, ['plugin']],
      [() => inventory.disablePlugin('plugin'), imported.disable, ['plugin']],
      [() => inventory.removePlugin('plugin'), imported.remove, ['plugin']],
      [() => inventory.trustPlugin('plugin'), imported.trustHooks, ['plugin']],
      [() => inventory.untrustPlugin('plugin'), imported.untrustHooks, ['plugin']],
      [() => inventory.setPluginMcpServerEnabled({ identity: 'plugin', server: 'server', enabled: true }),
        imported.setMcpServerEnabled, ['plugin', 'server', true]],
      [() => inventory.setPluginMcpToolApproval({ identity: 'plugin', server: 'server', tool: 'read', approval: 'deny' }),
        imported.setMcpToolApproval, ['plugin', 'server', 'read', 'deny']],
      [() => inventory.listMcpServers(), mcp.list, []],
      [() => inventory.defineMcpServer(server), mcp.define, [server]],
      [() => inventory.setMcpServerEnabled({ name: 'server', enabled: true }), mcp.setEnabled, [{ name: 'server', enabled: true }]],
      [() => inventory.removeMcpServer('server'), mcp.remove, ['server']],
      [() => inventory.listHookRecords(), hooks.list, []],
      [() => inventory.defineHookRecord(hook), hooks.define, [hook]],
      [() => inventory.setHookRecordEnabled({ name: 'hook', enabled: true }), hooks.setEnabled, [{ name: 'hook', enabled: true }]],
      [() => inventory.removeHookRecord('hook'), hooks.remove, ['hook']],
    ] as const
    for (const [call, handler, args] of calls) {
      await expect(call()).resolves.toBeDefined()
      expect(handler).toHaveBeenLastCalledWith(...args)
    }
  })

  it.each<AddPluginMarketplaceRequest>([
    { source: '' }, { source: 'x'.repeat(2049) }, { source: 'bad\u0000source' },
    { source: 'not a URL' }, { source: 'http://example.test/repo' },
    { source: 'https://user:pass@example.test/repo' }, { source: 'https://user@example.test/repo' },
    { source: 'https://example.test/repo?query' }, { source: 'https://example.test/repo#fragment' },
    { source: 'owner/repo', gitRef: '-main' }, { source: 'owner/repo', gitRef: 'a b' },
    { source: 'owner/repo', gitRef: 'x'.repeat(256) },
    ...['', '/absolute', '-option', 'C:/absolute', 'a//b', 'a/../b', './relative', 'x'.repeat(513)]
      .map(path => ({ source: 'owner/repo', sparsePaths: [path] })),
    { source: 'owner/repo', sparsePaths: Array.from({ length: 21 }, (_, index) => `path${index}`) },
  ])('rejects an invalid marketplace request %j', async (request) => {
    const { inventory } = await harness()
    await expect(inventory.addMarketplace(request)).rejects.toThrow('pluginInventory:')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each(['git@example.test:owner/repo.git', 'ssh://git@example.test/owner/repo', 'https://example.test/owner/repo'])
  ('accepts credential-free Git source %s with a validated ref', async (source) => {
    stubGitMarketplace()
    vi.stubEnv('HYDRA_MARKETPLACE_TEST_TOKEN', 'test-value')
    const { inventory } = await harness()
    const result = await inventory.addMarketplace({ source, gitRef: ' feature ', sparsePaths: ['plugins\\tools/', 'plugins/tools'] })
    expect(result.marketplaces[0]).toMatchObject({ gitRef: 'feature', sparsePaths: ['plugins/tools'] })
    expect(execFileMock.mock.calls.some(call => call[1].includes('check-ref-format'))).toBe(true)
    expect(execFileMock.mock.calls.some(call => call[1].includes('fetch'))).toBe(true)
    expect(execFileMock.mock.calls.some(call => call[1].includes('checkout'))).toBe(true)
    expect(execFileMock.mock.calls[0]?.[2]).not.toHaveProperty('env.HYDRA_MARKETPLACE_TEST_TOKEN')
  })

  it.each(['', 'network unavailable\nprivate details'])('reports Git failure with only its first diagnostic line', async (stderr) => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => { callback(new Error('failed'), '', stderr) })
    const { inventory } = await harness()
    await expect(inventory.addMarketplace({ source: 'owner/repo' })).rejects.toThrow(
      stderr === '' ? 'failed to load Git marketplace' : 'failed to load Git marketplace: network unavailable')
    await expect(inventory.addMarketplace({ source: 'owner/repo', gitRef: 'bad..ref' })).rejects.toThrow('Git ref is invalid')
  })

  it('updates an existing source, retains its disabled state and reports a missing persisted catalog', async () => {
    stubGitMarketplace()
    const { inventory } = await harness()
    await inventory.addMarketplace({ source: 'owner/first' })
    await inventory.addMarketplace({ source: 'owner/second' })
    await inventory.setMarketplaceEnabled({ source: 'https://github.com/owner/first.git', enabled: false })
    const changed = await inventory.addMarketplace({ source: 'owner/first', gitRef: 'main' })
    expect(changed.marketplaces).toHaveLength(2)
    expect(changed.marketplaces[0]).toMatchObject({ enabled: false, gitRef: 'main' })
    execFileMock.mockImplementation((_command, _args, _options, callback) => { callback(new Error('offline'), '', '') })
    expect((await inventory.listMarketplaces()).marketplaces.every(source => source.status === 'unavailable')).toBe(true)
    await expect(inventory.removeMarketplace('missing')).rejects.toThrow('not configured')
    await expect(inventory.setMarketplaceEnabled({ source: 'missing', enabled: true })).rejects.toThrow('not configured')
  })

  it('rejects local Git options, directories in place of catalogs, malformed and oversized documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-marketplace-invalid-'))
    directories.push(root)
    const { inventory } = await harness()
    await expect(inventory.addMarketplace({ source: root, gitRef: 'main' })).rejects.toThrow('require a Git source')
    await mkdir(join(root, '.agents', 'plugins', 'marketplace.json'), { recursive: true })
    await expect(inventory.addMarketplace({ source: root })).rejects.toThrow('missing')
    const filename = join(root, 'marketplace.json')
    for (const body of ['invalid', '{"plugins":[null]}', ' '.repeat(1024 * 1024 + 1)]) {
      await writeFile(filename, body)
      await expect(inventory.addMarketplace({ source: root })).rejects.toThrow()
    }
  })

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
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hydra-openai-marketplace-source-')))
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

  it('accepts the API-key marketplace filename and Codex catalog metadata', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hydra-openai-api-marketplace-')))
    directories.push(root)
    await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(root, '.agents', 'plugins', 'api_marketplace.json'), JSON.stringify({
      name: 'openai-api-curated',
      interface: { displayName: 'Codex official' },
      plugins: [
        { name: 'first', source: { source: 'local', path: './plugins/first' }, policy: { installation: 'AVAILABLE' } },
        { name: 'second', source: { source: 'local', path: './plugins/second' }, category: 'Developer Tools' },
      ],
    }))
    const { inventory } = await harness()

    await expect(inventory.addMarketplace({ source: root })).resolves.toMatchObject({
      marketplaces: [{ status: 'ready', source: root, enabled: true }],
    })
  })

  it('requires a Codex marketplace document before it persists a source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-openai-marketplace-empty-'))
    directories.push(root)
    const { inventory } = await harness()

    await expect(inventory.addMarketplace({ source: root })).rejects.toThrow('OpenAI/Codex marketplace.json is missing')
  })
})

describe('marketplace slot cascade', () => {
  it.each([1, 2])('retains the marketplace when %s imported-plugin removals fail', async (count) => {
    const { inventory, root, runtime } = await harnessWithSource()
    const first = (await runtime.list()).plugins[0]!
    runtime.list.mockResolvedValue({ plugins: Array.from({ length: count }, (_, index) => ({ ...first,
      identity: `plugin-${index}` as ImportedPluginIdentity })) })
    runtime.remove.mockRejectedValue(new Error('remove failed'))
    await expect(inventory.removeMarketplace(root)).rejects.toThrow(count === 1 ? 'remove failed' : 'failed to update plugins')
    expect(runtime.remove).toHaveBeenCalledTimes(count)
    expect((await inventory.listMarketplaces()).marketplaces).toHaveLength(1)
  })

  async function harnessWithSource(): Promise<{
    inventory: PluginInventoryGateway
    root: string
    runtime: ReturnType<typeof fakeImportedPluginsRuntime>
  }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hydra-openai-marketplace-cascade-')))
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
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hydra-openai-marketplace-no-runtime-')))
    directories.push(root)
    await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(root, '.agents', 'plugins', 'marketplace.json'), '{"plugins":[]}')
    await inventory.addMarketplace({ source: root })

    await expect(inventory.setMarketplaceEnabled({ source: root, enabled: false })).resolves.toBeDefined()
    await expect(inventory.removeMarketplace(root)).resolves.toEqual({ marketplaces: [] })
  })
})
