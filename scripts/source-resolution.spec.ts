import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { repositoryConfigHost } from './ts-project.ts'

it('resolves registry and personalization imports without built artifacts', () => {
  const root = resolve(import.meta.dirname, '..')
  const config = ts.getParsedCommandLineOfConfigFile(resolve(root, 'tsconfig.host.json'), {}, repositoryConfigHost)!
  const modules = [
    '@hydra1902/harness-plugin-runtime',
    '@hydra1902/harness-plugin-runtime/types',
    '@hydra1902/harness-hooks-registry',
    '@hydra1902/harness-hooks-registry/types',
    '@hydra1902/harness-mcp-registry',
    '@hydra1902/harness-mcp-registry/types',
    '@hydra1902/harness-personalization',
    '@hydra1902/harness-hooks-codex/config',
  ]
  const source = resolve(root, 'packages/host/plugin-inventory/src/index.ts')
  const host = { ...ts.sys, fileExists: (file: string) => !/[\\/]lib[\\/]/.test(file) && ts.sys.fileExists(file) }
  for (const module of modules) {
    const resolved = ts.resolveModuleName(module, source, config.options, host).resolvedModule
    expect(resolved?.resolvedFileName.replaceAll('\\', '/'), module).toMatch(/\/src\/(index|types|config)\.ts$/)
  }
})
