import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import type { Plugin } from 'vite'
import { expect, it, onTestFinished } from 'vitest'

const { pageAgentPatch } = await import(new URL('../page-agent-patch.js', import.meta.url).href) as {
  pageAgentPatch: (sourceDir: string, patchPath: string) => Plugin
}

it('bundles patched TypeScript and inline CSS without changing source or the real Git index', async () => {
  const root = mkdtempSync(join(tmpdir(), 'page-agent-patch-test-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' })
  const source = join(root, 'mask.ts')
  const css = join(root, 'cursor.module.css')
  const patch = join(root, 'cursor.patch')
  git('init', '--quiet')
  writeFileSync(source, 'export const mode: string = "upstream"\n')
  writeFileSync(css, '.cursor { color: red; }\n')
  writeFileSync(join(root, 'entry.ts'), `
    import { mode } from './mask.ts'
    import styles from './cursor.module.css'
    import css from './cursor.module.css?inline'
    console.log(mode, styles.cursor, css)
  `)
  git('add', '.')
  git('-c', 'user.name=Hydra Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture')
  writeFileSync(source, 'export const mode: string = "hydra"\n')
  writeFileSync(css, '.cursor { color: blue; }\n')
  writeFileSync(patch, git('diff', '--no-ext-diff', '--no-color'))
  git('restore', 'mask.ts', 'cursor.module.css')
  writeFileSync(join(root, 'local.txt'), 'staged work\n')
  git('add', 'local.txt')
  const index = readFileSync(join(root, '.git/index'))
  const originalSource = readFileSync(source)
  const originalCss = readFileSync(css)
  const bundle = (extra: Plugin[] = []) => build({
    root, configFile: false, logLevel: 'silent', plugins: [pageAgentPatch(root, patch), ...extra],
    build: { write: false, minify: false, lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: 'fixture' } },
  })
  const assertUntouched = () => {
    expect(readFileSync(source)).toEqual(originalSource)
    expect(readFileSync(css)).toEqual(originalCss)
    expect(readFileSync(join(root, '.git/index'))).toEqual(index)
  }

  const result = await bundle()
  expect(JSON.stringify(result)).toContain('hydra')
  expect(JSON.stringify(result)).toContain('blue')
  assertUntouched()
  await expect(bundle([{ name: 'failed-output', generateBundle() { throw new Error('output failed') } }])).rejects.toThrow('output failed')
  assertUntouched()

  git('apply', patch)
  const appliedSource = readFileSync(source)
  const appliedCss = readFileSync(css)
  expect(JSON.stringify(await bundle())).toContain('hydra')
  expect(readFileSync(source)).toEqual(appliedSource)
  expect(readFileSync(css)).toEqual(appliedCss)
  expect(readFileSync(join(root, '.git/index'))).toEqual(index)

  writeFileSync(source, 'export const mode = "local work"\n')
  await expect(bundle()).rejects.toThrow('conflicts with local edits in mask.ts')
  expect(readFileSync(source, 'utf8')).toContain('local work')
  expect(readFileSync(join(root, '.git/index'))).toEqual(index)
})
