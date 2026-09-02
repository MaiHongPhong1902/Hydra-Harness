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
import { Context } from '@bosch/cordis'
import Loader from '@bosch/cordis-plugin-loader'
import FileSettingsProvider from '@bosch/bh-settings-file'
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

async function harness(): Promise<PluginInventoryGateway> {
  const root = await mkdtemp(join(tmpdir(), 'bh-openai-marketplace-'))
  directories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
  await ctx.plugin(PluginInventoryGateway)
  return ctx.get('pluginInventory') as PluginInventoryGateway
}

describe('OpenAI/Codex marketplace sources', () => {
  it.each([
    { sparsePaths: [], sparseClone: false },
    { sparsePaths: ['plugins/codex'], sparseClone: true },
  ])('keeps the catalog readable with sparse clone $sparseClone', async ({ sparsePaths, sparseClone }) => {
    stubGitMarketplace()
    const inventory = await harness()

    await inventory.addMarketplace({ source: 'example/plugins', sparsePaths })

    const cloneCalls = execFileMock.mock.calls.filter(call => call[1].includes('clone'))
    expect(cloneCalls.length).toBeGreaterThan(0)
    expect(cloneCalls.every(call => call[1].includes('--sparse'))).toBe(sparseClone)
    const sparseCalls = execFileMock.mock.calls.filter(call => call[1].includes('sparse-checkout'))
    expect(sparseCalls).toHaveLength(sparseClone ? cloneCalls.length : 0)
    if (sparseClone) expect(sparseCalls[0]?.[1]).toContain('.agents/plugins')
  })

  it('stores a standard marketplace source without treating its entries as BH packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bh-openai-marketplace-source-'))
    directories.push(root)
    await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'OpenAI-compatible catalog',
      plugins: [{ name: 'ponytail', source: './ponytail' }],
    }))
    const inventory = await harness()

    const added = await inventory.addMarketplace({ source: root })
    expect(added).toEqual({ marketplaces: [{ status: 'ready', source: root, sparsePaths: [] }] })
    await expect(inventory.removeMarketplace(root)).resolves.toEqual({ marketplaces: [] })
  })

  it('requires a Codex marketplace document before it persists a source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bh-openai-marketplace-empty-'))
    directories.push(root)
    const inventory = await harness()

    await expect(inventory.addMarketplace({ source: root })).rejects.toThrow('OpenAI/Codex marketplace.json is missing')
  })
})
