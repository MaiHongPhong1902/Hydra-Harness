/** Account routes boot dormant through the Loader and follow persisted settings. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import Loader from '@hydra/cordis-plugin-loader'
import Include from '@hydra/cordis-plugin-include'
import Authorization from '@hydra/harness-authorization'
import { credentialKey } from '@hydra/harness-credentials'
import Credentials from '@hydra/harness-credentials-local'
import Llm from '@hydra/harness-llm'
import Settings from '@hydra/harness-settings-file'
import * as AccountAuth from '../src/index.ts'

const loaded = vi.hoisted(() => ({ adapters: vi.fn(), chatgpt: vi.fn(), oauth: vi.fn() }))
vi.mock('../src/adapter.ts', async (original) => {
  loaded.adapters()
  return original()
})
vi.mock('../src/chatgpt.ts', async (original) => {
  loaded.chatgpt()
  return original()
})
vi.mock('../src/antigravity-oauth.ts', async (original) => {
  loaded.oauth()
  return original()
})

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
})

it('boots without network work and enables only the account routes saved in settings', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected account network request'))
  root = await mkdtemp(join(tmpdir(), 'hydra-account-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '{}\n')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: test-llm',
    '- name: test-settings',
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- name: test-credentials',
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- name: test-authorization',
    '- name: test-account-auth',
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm', Llm], ['test-settings', Settings], ['test-credentials', Credentials],
    ['test-authorization', Authorization], ['test-account-auth', AccountAuth],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  expect(ctx.llm.listProviders()).toEqual([])
  expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['chatgpt', 'antigravity'])
  expect(await ctx.authorization.listAccounts(credentialKey('llm-account-auth', 'chatgpt'))).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
  expect(loaded.adapters).not.toHaveBeenCalled()
  expect(loaded.chatgpt).not.toHaveBeenCalled()
  expect(loaded.oauth).not.toHaveBeenCalled()

  await writeFile(settingsPath, [
    'llm-account-auth:',
    '  providers:',
    '    chatgpt:',
    '      models:',
    '        - id: gpt-test',
    '          name: Test ChatGPT',
    '          contextWindow: 128000',
    '',
  ].join('\n'))
  await vi.waitFor(() => {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['chatgpt'])
  }, { timeout: 5000 })
  expect(await ctx.llm.listModels('chatgpt')).toMatchObject([{ id: 'gpt-test', name: 'Test ChatGPT' }])
  expect(loaded.adapters).toHaveBeenCalledOnce()
  expect(loaded.chatgpt).toHaveBeenCalledOnce()
  expect(loaded.oauth).not.toHaveBeenCalled()

  await writeFile(settingsPath, '{}\n')
  await vi.waitFor(() => { expect(ctx.llm.listProviders()).toEqual([]) }, { timeout: 5000 })
  expect(ctx.authorization.list().map(entry => entry.key)).toEqual([
    'llm-account-auth/chatgpt', 'llm-account-auth/antigravity',
  ])
  expect(fetch).not.toHaveBeenCalled()
  const { llm, authorization } = ctx
  await ctx.fiber.dispose()
  expect(llm.listConfigurableProviders()).toEqual([])
  expect(authorization.list()).toEqual([])
})
