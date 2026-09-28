import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertClientBuildEnvironment,
  clientBuildEnvironmentDefines,
  clientBuildProcessEnvironment,
  readClientBuildRecord,
  repositoryCommitHash,
  resolveClientBuildEnvironment,
  writeClientBuildRecord,
} from './client-build-environment.ts'
import { clientBundle } from '../packages/client/tsdown.client.ts'

const root = resolve(import.meta.dirname, '..')
const PROBE_NAME = 'HYDRA_CLIENT_BUILD_TEST'
const COMMIT_HASH = '0123456789abcdef0123456789abcdef01234567'
const PROBE_KEY = `process.env.${PROBE_NAME}`
const originalProbe = process.env[PROBE_NAME]
const roots: string[] = []
const hydraBuildWorkflows = [
  'build-exe-for-python-sdk.yml',
  'ci.yml',
  'release.yml',
  'release-publish.yml',
  'sandbox.yml',
]

afterEach(() => {
  if (originalProbe === undefined) Reflect.deleteProperty(process.env, PROBE_NAME)
  else process.env[PROBE_NAME] = originalProbe
  vi.resetModules()
  for (const fixtureRoot of roots.splice(0)) rmSync(fixtureRoot, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function buildFixture(environment: Record<string, string>): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'hydra-client-build-'))
  roots.push(fixtureRoot)
  write(join(fixtureRoot, 'apps/web/dist/index.html'), '<main></main>')
  write(join(fixtureRoot, 'packages/client/example/lib/client.js'), 'module.exports = {}\n')
  writeClientBuildRecord(fixtureRoot, environment)
  return fixtureRoot
}

describe('client build environment', () => {
  it('requires an exact public environment for a named artifact profile', () => {
    const expected = {
      HYDRA_CLIENT_BUILD_PROFILE: 'official',
      HYDRA_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      HYDRA_CLIENT_TITLE: 'Hydra harness',
    } as const

    expect(() => { assertClientBuildEnvironment({ PATH: '/bin', ...expected }, expected) }).not.toThrow()
    expect(() => { assertClientBuildEnvironment({}, expected) }).toThrow(/HYDRA_CLIENT_TITLE/)
    expect(() => { assertClientBuildEnvironment({ HYDRA_CLIENT_TITLE: 'Other' }, expected) }).toThrow(/HYDRA_CLIENT_TITLE/)
    expect(() => {
      assertClientBuildEnvironment({ ...expected, HYDRA_CLIENT_UNDECLARED: 'value' }, expected)
    }).toThrow(/HYDRA_CLIENT_UNDECLARED/)
  })

  it('inherits public values by default and isolates an explicit official profile', () => {
    const parent = {
      PATH: '/bin',
      HYDRA_BUILD_CLIENT_PROFILE: 'official',
      HYDRA_CLIENT_BUILD_PROFILE: 'local',
      HYDRA_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      HYDRA_CLIENT_TITLE: 'Local title',
      HYDRA_CLIENT_EXTRA: 'local-extra',
    }

    expect(resolveClientBuildEnvironment({ HYDRA_CLIENT_TITLE: 'Local title' })).toEqual({
      HYDRA_CLIENT_TITLE: 'Local title',
    })
    expect(resolveClientBuildEnvironment(parent)).toEqual({
      HYDRA_CLIENT_BUILD_PROFILE: 'official',
      HYDRA_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      HYDRA_CLIENT_TITLE: 'Hydra harness',
    })
    expect(() => {
      resolveClientBuildEnvironment({ HYDRA_BUILD_CLIENT_PROFILE: 'official' })
    }).toThrow(/HYDRA_CLIENT_COMMIT_HASH/)
    expect(() => { resolveClientBuildEnvironment({}, 'unknown') }).toThrow(/unknown client build profile/)
    expect(clientBuildProcessEnvironment(parent, {
      HYDRA_CLIENT_BUILD_PROFILE: 'official',
      HYDRA_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      HYDRA_CLIENT_TITLE: 'Hydra harness',
    })).toEqual({
      PATH: '/bin',
      HYDRA_CLIENT_BUILD_PROFILE: 'official',
      HYDRA_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      HYDRA_CLIENT_TITLE: 'Hydra harness',
    })
    expect(repositoryCommitHash('/unused', { HYDRA_CLIENT_COMMIT_HASH: COMMIT_HASH })).toBe(COMMIT_HASH.slice(0, 7))
  })

  it('defines only public client values over a non-enumerable fallback', () => {
    expect(clientBuildEnvironmentDefines({
      PATH: '/bin',
      HYDRA_TEST_API_KEY: 'secret',
      HYDRA_CLIENT_VARIANT: 'quoted "value"',
      HYDRA_CLIENT_EMPTY: '',
      HYDRA_CLIENT_UNSET: undefined,
    })).toEqual({
      'process.env': '{}',
      'process.env.HYDRA_CLIENT_EMPTY': '""',
      'process.env.HYDRA_CLIENT_VARIANT': '"quoted \\"value\\""',
    })
  })

  it('feeds the same build-process value to dynamic tsdown bundles and the Vite shell', async () => {
    process.env[PROBE_NAME] = 'shared-value'

    const configs = clientBundle('@hydraharness/harness-client-ui-sidebar', [
      'lib/types/index.js',
      'lib/types/invariant.js',
    ])({ env: { HYDRA_BUILD_FACE: 'client' } })
    if (!Array.isArray(configs)) throw new TypeError('client bundle config must be an array')
    const dynamic = configs.find(config => config.name === '@hydraharness/harness-client-ui-sidebar/client')
    expect(dynamic?.define).toMatchObject({
      'process.env': '{}',
      [PROBE_KEY]: '"shared-value"',
    })

    const viteConfigPath = '../apps/web/vite.config.ts'
    const viteModule: unknown = await import(viteConfigPath)
    if (typeof viteModule !== 'object' || viteModule === null) {
      throw new TypeError('web Vite config module must be an object')
    }
    const viteConfig: unknown = Reflect.get(viteModule, 'default')
    if (typeof viteConfig === 'function') throw new TypeError('web Vite config must be an object')
    if (typeof viteConfig !== 'object' || viteConfig === null) {
      throw new TypeError('web Vite config must be an object')
    }
    expect(Reflect.get(viteConfig, 'define')).toMatchObject({
      'process.env': '{}',
      [PROBE_KEY]: '"shared-value"',
    })
  })

  it('binds the recorded environment to a complete set of client artifacts', () => {
    const officialEnvironment = {
      HYDRA_CLIENT_BUILD_PROFILE: 'official',
      HYDRA_CLIENT_COMMIT_HASH: COMMIT_HASH.slice(0, 7),
      HYDRA_CLIENT_TITLE: 'Hydra harness',
    }
    const official = buildFixture(officialEnvironment)
    const defaultBuild = buildFixture({})

    expect(readClientBuildRecord(official, officialEnvironment).environment).toEqual(officialEnvironment)
    expect(() => { readClientBuildRecord(defaultBuild, officialEnvironment) }).toThrow(/HYDRA_CLIENT_/)
    expect(() => { readClientBuildRecord(join(defaultBuild, 'missing')) }).toThrow(/record.*missing/)

    write(join(official, 'apps/web/dist/index.html'), '<main>changed</main>')
    expect(() => { readClientBuildRecord(official) }).toThrow(/artifacts differ/)
  })

  it('keeps public client values out of workflow-wide environments', () => {
    for (const name of hydraBuildWorkflows) {
      const path = `.github/workflows/${name}`
      const document: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
      if (typeof document !== 'object' || document === null || Array.isArray(document)) {
        throw new TypeError(`${path} must contain a workflow object`)
      }
      expect(JSON.stringify(document), path).not.toContain('HYDRA_CLIENT_')
    }
  })
})
