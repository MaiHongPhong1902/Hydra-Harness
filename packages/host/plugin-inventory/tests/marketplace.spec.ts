type ExecFileCallback = (
  error: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr: string,
) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    encoding: string
    maxBuffer: number
    windowsHide: boolean
    env?: NodeJS.ProcessEnv
  },
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@bosch/cordis'
import Loader from '@bosch/cordis-plugin-loader'
import Include from '@bosch/cordis-plugin-include'
import { settingsNamespace } from '@bosch/bh-settings'
import FileSettingsProvider from '@bosch/bh-settings-file'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PluginInventoryGateway from '../src/index.ts'
import type { MarketplacePluginId, PluginMarketplaceSnapshot } from '../src/types.ts'

const SOURCE = 'https://plugins.example/marketplace.json'
const PACKAGE = '@example/bh-plugin'
const contexts: Context[] = []
const tempDirs: string[] = []
const originalArgv = [...process.argv]
const originalExecArgv = [...process.execArgv]
const originalElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron')

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  execFileMock.mockReset()
  process.argv.splice(0, process.argv.length, ...originalArgv)
  process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv)
  if (originalElectron === undefined) {
    Reflect.deleteProperty(process.versions, 'electron')
  } else {
    Object.defineProperty(process.versions, 'electron', originalElectron)
  }
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function marketplace(version = '1.2.3', packageName = PACKAGE) {
  return {
    name: 'Example marketplace',
    plugins: [{
      id: 'example-plugin',
      name: 'Example plugin',
      description: 'Adds one example capability.',
      package: packageName,
      version,
    }],
  }
}

async function managedHarness(): Promise<{
  inventory: PluginInventoryGateway
  profileDir: string
  manifestPath: string
  ctx: Context
}> {
  const home = await mkdtemp(join(tmpdir(), 'bh-plugin-marketplace-'))
  tempDirs.push(home)
  vi.stubEnv('BH_HOME', home)
  const profileDir = join(home, 'profiles', 'marketplace-test')
  await mkdir(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  await writeFile(manifestPath, JSON.stringify({
    name: 'marketplace-test',
    private: true,
    bh: { profile: { bundles: [] } },
  }, undefined, 2) + '\n')
  const configPath = join(profileDir, 'cordis.patch.yml')
  await writeFile(configPath, '[]\n')

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await ctx.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  await ctx.plugin(PluginInventoryGateway)
  return {
    inventory: ctx.get('pluginInventory') as PluginInventoryGateway,
    profileDir,
    manifestPath,
    ctx,
  }
}

function stubMarketplace(document: () => unknown = marketplace): ReturnType<typeof vi.fn> {
  const request = vi.fn(async () => new Response(JSON.stringify(document()), {
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', request)
  return request
}

async function writeInstalledManifest(path: string, version: string, bundle: boolean): Promise<void> {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as {
    dependencies?: Record<string, string>
    bh: { profile: { bundles: string[] } }
  }
  manifest.dependencies = { ...manifest.dependencies, [PACKAGE]: version }
  if (bundle && !manifest.bh.profile.bundles.includes(PACKAGE)) manifest.bh.profile.bundles.push(PACKAGE)
  await writeFile(path, JSON.stringify(manifest, undefined, 2) + '\n')
}

function firstPluginId(snapshot: PluginMarketplaceSnapshot): MarketplacePluginId {
  const first = snapshot.marketplaces[0]
  if (first?.status !== 'ready' || first.plugins[0] === undefined) throw new Error('fixture catalog is empty')
  return first.plugins[0].id
}

describe('plugin marketplace Host flow', () => {
  it('validates and persists one catalog without accepting remote plain HTTP', async () => {
    const { ctx, inventory } = await managedHarness()
    const fetchMock = stubMarketplace()

    const snapshot = await inventory.addMarketplace({ source: SOURCE })
    expect(snapshot.marketplaces).toEqual([{
      status: 'ready',
      source: SOURCE,
      name: 'Example marketplace',
      plugins: [{
        id: expect.stringMatching(/^[0-9a-f]{64}$/u),
        name: 'Example plugin',
        description: 'Adds one example capability.',
        packageName: PACKAGE,
        version: '1.2.3',
        installed: false,
      }],
    }])
    expect(ctx.settings.get(settingsNamespace('plugin-marketplaces'))).toEqual({ sources: [SOURCE] })
    await inventory.addMarketplace({ source: SOURCE })
    expect(ctx.settings.get(settingsNamespace('plugin-marketplaces'))).toEqual({ sources: [SOURCE] })
    expect(fetchMock).toHaveBeenCalledWith(SOURCE, expect.objectContaining({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }))

    await expect(inventory.addMarketplace({ source: 'http://plugins.example/marketplace.json' }))
      .rejects.toThrow('must use HTTPS or loopback HTTP')
  })

  it('stops reading a chunked catalog as soon as it crosses the byte limit', async () => {
    const { inventory } = await managedHarness()
    const cancel = vi.fn(async () => {})
    const releaseLock = vi.fn()
    const read = vi.fn(async () => ({ done: false as const, value: new Uint8Array(1024 * 1024 + 1) }))
    const text = vi.fn(async () => { throw new Error('unbounded response read') })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
      text,
    } as unknown as Response)))

    await expect(inventory.addMarketplace({ source: SOURCE })).rejects.toThrow('exceeds 1048576 bytes')
    expect(read).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(releaseLock).toHaveBeenCalledOnce()
    expect(text).not.toHaveBeenCalled()
  })

  it('accepts only exact SemVer versions and valid npm package names', async () => {
    const { ctx, inventory } = await managedHarness()
    stubMarketplace(() => marketplace('1.2.3-alpha.01'))

    await expect(inventory.addMarketplace({ source: SOURCE })).rejects.toThrow()
    for (const packageName of ['node_modules', 'favicon.ico']) {
      stubMarketplace(() => marketplace('1.2.3', packageName))
      await expect(inventory.addMarketplace({ source: SOURCE })).rejects.toThrow()
    }
    expect(ctx.settings.get(settingsNamespace('plugin-marketplaces'))).toEqual({ sources: [] })
  })

  it('installs the Host-resolved exact version without offering an update', async () => {
    const { inventory, manifestPath, profileDir } = await managedHarness()
    let version = '1.2.3'
    stubMarketplace(() => marketplace(version))
    const pluginId = firstPluginId(await inventory.addMarketplace({ source: SOURCE }))
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const packageSpec = args.at(-1) ?? ''
      const requestedVersion = packageSpec.slice(packageSpec.lastIndexOf('@') + 1)
      void writeInstalledManifest(manifestPath, requestedVersion, true).then(
        () => { callback(null, '', '') },
        (error) => { callback(error as Error, '', '') },
      )
    })

    const installed = await inventory.installMarketplacePlugin({
      source: SOURCE,
      pluginId,
    })
    expect(installed.restartRequired).toBe(true)
    expect(installed.snapshot.marketplaces[0]).toMatchObject({
      status: 'ready',
      plugins: [{ installed: true, version: '1.2.3' }],
    })
    const [command, args, options] = execFileMock.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual([
      process.argv[1],
      'plugin', '--profile', 'marketplace-test',
      'add', '--save-exact', '--ignore-scripts', `${PACKAGE}@1.2.3`,
    ])
    expect(options).toMatchObject({ cwd: profileDir, encoding: 'utf8', windowsHide: true })
    expect(options).not.toHaveProperty('shell')

    expect((await inventory.installMarketplacePlugin({
      source: SOURCE,
      pluginId,
    })).restartRequired).toBe(false)
    expect(execFileMock).toHaveBeenCalledOnce()

    version = '2.0.0'
    const updatedCatalog = await inventory.listMarketplaces()
    expect(updatedCatalog).toMatchObject({
      marketplaces: [{ status: 'ready', plugins: [{ installed: true, version: '2.0.0' }] }],
    })
    await expect(inventory.installMarketplacePlugin({ source: SOURCE, pluginId }))
      .rejects.toThrow('has no plugin')
    expect((await inventory.installMarketplacePlugin({
      source: SOURCE,
      pluginId: firstPluginId(updatedCatalog),
    })).restartRequired).toBe(false)
    expect(execFileMock).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'source CLI',
      cliEntry: 'C:\\repo\\apps\\cli\\src\\bin.ts',
      execArgv: ['--inspect=0', '--import', 'tsx/esm', '--trace-warnings'],
      expectedPrefix: ['--import', 'tsx/esm'],
      electron: false,
    },
    {
      name: 'built CLI',
      cliEntry: 'C:\\repo\\apps\\cli\\lib\\bin.js',
      execArgv: ['--expose-internals'],
      expectedPrefix: [],
      electron: false,
    },
    {
      name: 'Electron utility process',
      cliEntry: 'C:\\app\\resources\\app.asar\\node_modules\\@bosch\\bh\\lib\\bin.js',
      execArgv: ['--inspect=0'],
      expectedPrefix: [],
      electron: true,
    },
  ])('invokes the $name with only its required runtime flags', async ({
    cliEntry,
    electron,
    execArgv,
    expectedPrefix,
  }) => {
    const { inventory, manifestPath } = await managedHarness()
    stubMarketplace()
    const pluginId = firstPluginId(await inventory.addMarketplace({ source: SOURCE }))
    process.argv[1] = cliEntry
    process.execArgv.splice(0, process.execArgv.length, ...execArgv)
    if (electron) {
      Object.defineProperty(process.versions, 'electron', {
        configurable: true,
        value: '43.4.1',
      })
      vi.stubEnv('BH_MARKETPLACE_TEST', 'preserved')
    }
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      void writeInstalledManifest(manifestPath, '1.2.3', true).then(
        () => { callback(null, '', '') },
        (error) => { callback(error as Error, '', '') },
      )
    })

    await inventory.installMarketplacePlugin({ source: SOURCE, pluginId })

    const [command, args, options] = execFileMock.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual([
      ...expectedPrefix,
      cliEntry,
      'plugin', '--profile', 'marketplace-test',
      'add', '--save-exact', '--ignore-scripts', `${PACKAGE}@1.2.3`,
    ])
    if (electron) {
      expect(options.env).toEqual(expect.objectContaining({
        BH_MARKETPLACE_TEST: 'preserved',
        ELECTRON_RUN_AS_NODE: '1',
      }))
    } else {
      expect(options).not.toHaveProperty('env')
    }
  })

  it('restores the profile manifest when a catalog package is not a bundle', async () => {
    const { inventory, manifestPath, profileDir } = await managedHarness()
    stubMarketplace()
    const pluginId = firstPluginId(await inventory.addMarketplace({ source: SOURCE }))
    const before = await readFile(manifestPath, 'utf8')
    const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    execFileMock
      .mockImplementationOnce((_command, _args, _options, callback) => {
        void Promise.all([
          writeInstalledManifest(manifestPath, '1.2.3', false),
          writeFile(lockfilePath, 'mutated by add\n'),
        ]).then(
          () => { callback(null, '', '') },
          (error) => { callback(error as Error, '', '') },
        )
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        void writeFile(lockfilePath, 'created by rollback install\n').then(
          () => { callback(null, '', '') },
          (error) => { callback(error as Error, '', '') },
        )
      })

    await expect(inventory.installMarketplacePlugin({
      source: SOURCE,
      pluginId,
    })).rejects.toThrow('declares no installable bh bundle')
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
    await expect(readFile(lockfilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(execFileMock.mock.calls[1]?.[1]).toEqual([
      process.argv[1],
      'plugin', '--profile', 'marketplace-test',
      'install', '--ignore-scripts',
    ])
  })

  it('reconciles a failed add even when only its lockfile changed', async () => {
    const { inventory, manifestPath, profileDir } = await managedHarness()
    stubMarketplace()
    const pluginId = firstPluginId(await inventory.addMarketplace({ source: SOURCE }))
    const beforeManifest = await readFile(manifestPath, 'utf8')
    const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    const beforeLockfile = 'lockfileVersion: 9.0\n'
    await writeFile(lockfilePath, beforeLockfile)
    execFileMock
      .mockImplementationOnce((_command, _args, _options, callback) => {
        void writeFile(lockfilePath, 'partially changed\n').then(
          () => { callback(new Error('pnpm failed'), '', 'network unavailable\n') },
          (error) => { callback(error as Error, '', '') },
        )
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        void writeFile(lockfilePath, 'changed by rollback install\n').then(
          () => { callback(null, '', '') },
          (error) => { callback(error as Error, '', '') },
        )
      })

    await expect(inventory.installMarketplacePlugin({ source: SOURCE, pluginId }))
      .rejects.toThrow(`failed to install ${PACKAGE}@1.2.3: network unavailable`)
    expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest)
    expect(await readFile(lockfilePath, 'utf8')).toBe(beforeLockfile)
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })
})
