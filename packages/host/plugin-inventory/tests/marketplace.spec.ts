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
    env?: NodeJS.ProcessEnv
    maxBuffer: number
    timeout?: number
    windowsHide: boolean
  },
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

const GIT_SOURCE = 'openai/plugins'
const NORMALIZED_GIT_SOURCE = 'https://github.com/openai/plugins.git'
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

async function writeMarketplace(path: string, version = '1.2.3', packageName = PACKAGE): Promise<void> {
  await writeFile(path, JSON.stringify(marketplace(version, packageName)))
}

async function managedHarness(): Promise<{
  inventory: PluginInventoryGateway
  marketplaceDir: string
  marketplacePath: string
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
  const marketplaceDir = join(home, 'local-marketplace')
  await mkdir(marketplaceDir)
  const marketplacePath = join(marketplaceDir, 'marketplace.json')
  await writeMarketplace(marketplacePath)

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
    marketplaceDir,
    marketplacePath,
    profileDir,
    manifestPath,
    ctx,
  }
}

function stubGitMarketplace(
  document: () => unknown = marketplace,
  onCloneActivity?: (delta: 1 | -1) => void,
): void {
  execFileMock.mockImplementation((command, args, _options, callback) => {
    if (command !== 'git') {
      callback(new Error(`unexpected command ${command}`), '', '')
      return
    }
    if (args.includes('clone')) {
      const checkout = args.at(-1)
      if (checkout === undefined) throw new Error('clone target missing')
      onCloneActivity?.(1)
      void mkdir(checkout, { recursive: true })
        .then(() => writeFile(join(checkout, 'marketplace.json'), JSON.stringify(document())))
        .then(
          () => {
            onCloneActivity?.(-1)
            callback(null, '', '')
          },
          (error: unknown) => {
            onCloneActivity?.(-1)
            callback(error as Error, '', '')
          },
        )
      return
    }
    const ref = args.at(-1) ?? ''
    if (args.includes('check-ref-format') && (ref.includes('~') || ref.includes('..'))) {
      callback(new Error('invalid ref'), '', '')
      return
    }
    callback(null, '', '')
  })
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

async function addLocalMarketplace(
  inventory: PluginInventoryGateway,
  marketplaceDir: string,
): Promise<{ source: string; pluginId: MarketplacePluginId }> {
  const snapshot = await inventory.addMarketplace({ source: marketplaceDir })
  const source = snapshot.marketplaces[0]?.source
  if (source === undefined) throw new Error('fixture source is missing')
  return { source, pluginId: firstPluginId(snapshot) }
}

describe('plugin marketplace Host flow', () => {
  it('normalizes a Git source and applies its ref and sparse checkout paths', async () => {
    const { ctx, inventory } = await managedHarness()
    vi.stubEnv('MARKETPLACE_TOKEN', 'not-for-git')
    vi.stubEnv('MARKETPLACE_VISIBLE', 'preserved')
    stubGitMarketplace()

    const snapshot = await inventory.addMarketplace({
      source: GIT_SOURCE,
      gitRef: ' main ',
      sparsePaths: ['plugins/z', ' plugins/a ', 'plugins/a'],
    })
    expect(snapshot.marketplaces).toEqual([{
      status: 'ready',
      source: NORMALIZED_GIT_SOURCE,
      gitRef: 'main',
      sparsePaths: ['plugins/a', 'plugins/z'],
      name: 'Example marketplace',
      plugins: [{
        id: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
        name: 'Example plugin',
        description: 'Adds one example capability.',
        packageName: PACKAGE,
        version: '1.2.3',
        installed: false,
      }],
    }])
    expect(ctx.settings.get(settingsNamespace('plugin-marketplaces'))).toEqual({
      sources: [{
        source: NORMALIZED_GIT_SOURCE,
        gitRef: 'main',
        sparsePaths: ['plugins/a', 'plugins/z'],
      }],
    })

    const cloneCall = execFileMock.mock.calls.find(call => call[1].includes('clone'))
    expect(cloneCall?.[0]).toBe('git')
    expect(cloneCall?.[1]).toEqual([
      '-c', 'protocol.ext.allow=never',
      '-c', 'protocol.file.allow=never',
      'clone', '--depth', '1', '--filter=blob:none', '--sparse', '--no-checkout', '--',
      NORMALIZED_GIT_SOURCE,
      expect.any(String),
    ])
    expect(cloneCall?.[2]).toMatchObject({ timeout: 30_000, windowsHide: true })
    expect(cloneCall?.[2].env).toEqual(expect.objectContaining({
      GCM_INTERACTIVE: 'Never',
      GIT_TERMINAL_PROMPT: '0',
      MARKETPLACE_VISIBLE: 'preserved',
    }))
    expect(cloneCall?.[2].env).not.toHaveProperty('MARKETPLACE_TOKEN')
    expect(execFileMock.mock.calls.some(call => call[1].includes('fetch') && call[1].at(-1) === 'main')).toBe(true)
    expect(execFileMock.mock.calls.some(call => call[1].slice(-7).join('\0') === [
      'sparse-checkout', 'set', '--cone', '--sparse-index', '--', 'plugins/a', 'plugins/z',
    ].join('\0'))).toBe(true)
    expect(execFileMock.mock.calls.slice(0, 5).map((call) => {
      if (call[1].includes('check-ref-format')) return 'check-ref-format'
      if (call[1].includes('clone')) return 'clone'
      if (call[1].includes('fetch')) return 'fetch'
      if (call[1].includes('sparse-checkout')) return 'sparse-checkout'
      if (call[1].includes('checkout')) return 'checkout'
      return 'unexpected'
    })).toEqual(['check-ref-format', 'clone', 'fetch', 'sparse-checkout', 'checkout'])

    execFileMock.mockClear()
    await inventory.addMarketplace({ source: NORMALIZED_GIT_SOURCE })
    expect(execFileMock.mock.calls.find(call => call[1].includes('clone'))?.[1]).toEqual([
      '-c', 'protocol.ext.allow=never',
      '-c', 'protocol.file.allow=never',
      'clone', '--depth', '1', '--filter=blob:none', '--sparse', '--',
      NORMALIZED_GIT_SOURCE,
      expect.any(String),
    ])
    expect(ctx.settings.get(settingsNamespace('plugin-marketplaces'))).toEqual({
      sources: [{ source: NORMALIZED_GIT_SOURCE, gitRef: '', sparsePaths: [] }],
    })
  })

  it('accepts a local root and rejects Git-only or unsafe source fields', async () => {
    const { inventory, marketplaceDir } = await managedHarness()
    stubGitMarketplace()
    const snapshot = await inventory.addMarketplace({ source: marketplaceDir })
    expect(snapshot.marketplaces[0]).toMatchObject({
      status: 'ready',
      source: marketplaceDir,
      sparsePaths: [],
    })
    expect(execFileMock).not.toHaveBeenCalled()

    await expect(inventory.addMarketplace({ source: marketplaceDir, gitRef: 'main' }))
      .rejects.toThrow('Git ref and sparse paths require a Git source')
    await expect(inventory.addMarketplace({ source: 'http://plugins.example/repo.git' }))
      .rejects.toThrow('must use HTTPS or SSH')
    await expect(inventory.addMarketplace({ source: GIT_SOURCE, sparsePaths: ['../outside'] }))
      .rejects.toThrow('must be repository-relative')
    await expect(inventory.addMarketplace({
      source: GIT_SOURCE,
      sparsePaths: ['a'.repeat(513)],
    })).rejects.toThrow('at most 512 characters')
    await expect(inventory.addMarketplace({ source: GIT_SOURCE, gitRef: '--upload-pack=evil' }))
      .rejects.toThrow('Git ref is invalid')
    await expect(inventory.addMarketplace({ source: GIT_SOURCE, gitRef: 'main~1' }))
      .rejects.toThrow('Git ref is invalid')
  })

  it('prefers GitHub shorthand over a colliding relative folder', async () => {
    const { inventory } = await managedHarness()
    const collisionRoot = await mkdtemp(join(tmpdir(), 'bh-marketplace-collision-'))
    tempDirs.push(collisionRoot)
    await mkdir(join(collisionRoot, 'openai', 'plugins'), { recursive: true })
    stubGitMarketplace()
    const previousCwd = process.cwd()
    process.chdir(collisionRoot)
    try {
      const snapshot = await inventory.addMarketplace({ source: GIT_SOURCE })
      expect(snapshot.marketplaces[0]?.source).toBe(NORMALIZED_GIT_SOURCE)
      expect(execFileMock.mock.calls.some(call => call[1].includes('clone'))).toBe(true)
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('loads persisted Git marketplaces one at a time', async () => {
    const { inventory } = await managedHarness()
    let activeClones = 0
    let peakClones = 0
    stubGitMarketplace(marketplace, (delta) => {
      activeClones += delta
      peakClones = Math.max(peakClones, activeClones)
    })

    await inventory.addMarketplace({ source: 'example/one' })
    await inventory.addMarketplace({ source: 'example/two' })

    expect(peakClones).toBe(1)
  })

  it('rejects a local catalog that exceeds the byte limit before parsing it', async () => {
    const { inventory, marketplaceDir, marketplacePath } = await managedHarness()
    await writeFile(marketplacePath, Buffer.alloc(1024 * 1024 + 1))

    await expect(inventory.addMarketplace({ source: marketplaceDir }))
      .rejects.toThrow('exceeds 1048576 bytes')
  })

  it.skipIf(process.platform === 'win32')('rejects a link-shaped marketplace document', async () => {
    const { inventory, marketplaceDir, marketplacePath } = await managedHarness()
    const outside = join(marketplaceDir, '..', 'outside-marketplace.json')
    await writeMarketplace(outside)
    await rm(marketplacePath)
    await symlink(outside, marketplacePath, 'file')

    await expect(inventory.addMarketplace({ source: marketplaceDir })).rejects.toThrow('is not a file')
  })

  it('accepts only exact SemVer versions and valid npm package names', async () => {
    const { ctx, inventory, marketplaceDir, marketplacePath } = await managedHarness()
    await writeMarketplace(marketplacePath, '1.2.3-alpha.01')

    await expect(inventory.addMarketplace({ source: marketplaceDir })).rejects.toThrow()
    for (const packageName of ['node_modules', 'favicon.ico']) {
      await writeMarketplace(marketplacePath, '1.2.3', packageName)
      await expect(inventory.addMarketplace({ source: marketplaceDir })).rejects.toThrow()
    }
    expect(ctx.settings.get(settingsNamespace('plugin-marketplaces'))).toEqual({ sources: [] })
  })

  it('installs the Host-resolved exact version without offering an update', async () => {
    const { inventory, marketplaceDir, marketplacePath, manifestPath, profileDir } = await managedHarness()
    const { source, pluginId } = await addLocalMarketplace(inventory, marketplaceDir)
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const packageSpec = args.at(-1) ?? ''
      const requestedVersion = packageSpec.slice(packageSpec.lastIndexOf('@') + 1)
      void writeInstalledManifest(manifestPath, requestedVersion, true).then(
        () => { callback(null, '', '') },
        (error: unknown) => { callback(error as Error, '', '') },
      )
    })

    const installed = await inventory.installMarketplacePlugin({ source, pluginId })
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

    expect((await inventory.installMarketplacePlugin({ source, pluginId })).restartRequired).toBe(false)
    expect(execFileMock).toHaveBeenCalledOnce()

    await writeMarketplace(marketplacePath, '2.0.0')
    const updatedCatalog = await inventory.listMarketplaces()
    expect(updatedCatalog).toMatchObject({
      marketplaces: [{ status: 'ready', plugins: [{ installed: true, version: '2.0.0' }] }],
    })
    await expect(inventory.installMarketplacePlugin({ source, pluginId })).rejects.toThrow('has no plugin')
    expect((await inventory.installMarketplacePlugin({
      source,
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
    const { inventory, marketplaceDir, manifestPath } = await managedHarness()
    const { source, pluginId } = await addLocalMarketplace(inventory, marketplaceDir)
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
        (error: unknown) => { callback(error as Error, '', '') },
      )
    })

    await inventory.installMarketplacePlugin({ source, pluginId })

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
    const { inventory, marketplaceDir, manifestPath, profileDir } = await managedHarness()
    const { source, pluginId } = await addLocalMarketplace(inventory, marketplaceDir)
    const before = await readFile(manifestPath, 'utf8')
    const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    execFileMock
      .mockImplementationOnce((_command, _args, _options, callback) => {
        void Promise.all([
          writeInstalledManifest(manifestPath, '1.2.3', false),
          writeFile(lockfilePath, 'mutated by add\n'),
        ]).then(
          () => { callback(null, '', '') },
          (error: unknown) => { callback(error as Error, '', '') },
        )
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        void writeFile(lockfilePath, 'created by rollback install\n').then(
          () => { callback(null, '', '') },
          (error: unknown) => { callback(error as Error, '', '') },
        )
      })

    await expect(inventory.installMarketplacePlugin({ source, pluginId }))
      .rejects.toThrow('declares no installable bh bundle')
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
    await expect(readFile(lockfilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(execFileMock.mock.calls[1]?.[1]).toEqual([
      process.argv[1],
      'plugin', '--profile', 'marketplace-test',
      'install', '--ignore-scripts',
    ])
  })

  it('reconciles a failed add even when only its lockfile changed', async () => {
    const { inventory, marketplaceDir, manifestPath, profileDir } = await managedHarness()
    const { source, pluginId } = await addLocalMarketplace(inventory, marketplaceDir)
    const beforeManifest = await readFile(manifestPath, 'utf8')
    const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    const beforeLockfile = 'lockfileVersion: 9.0\n'
    await writeFile(lockfilePath, beforeLockfile)
    execFileMock
      .mockImplementationOnce((_command, _args, _options, callback) => {
        void writeFile(lockfilePath, 'partially changed\n').then(
          () => { callback(new Error('pnpm failed'), '', 'network unavailable\n') },
          (error: unknown) => { callback(error as Error, '', '') },
        )
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        void writeFile(lockfilePath, 'changed by rollback install\n').then(
          () => { callback(null, '', '') },
          (error: unknown) => { callback(error as Error, '', '') },
        )
      })

    await expect(inventory.installMarketplacePlugin({ source, pluginId }))
      .rejects.toThrow(`failed to install ${PACKAGE}@1.2.3: network unavailable`)
    expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest)
    expect(await readFile(lockfilePath, 'utf8')).toBe(beforeLockfile)
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })
})
