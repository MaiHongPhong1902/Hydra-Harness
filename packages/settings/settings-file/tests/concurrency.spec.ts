// Cross-instance and writer-lock behavior: two providers on one document are
// the in-process equivalent of two hydra processes sharing a harness home —
// neither knows the other's cache, so only the read-modify-write cycle under
// the `<file>.lock` sibling keeps both namespaces alive on disk.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@hydra1902/cordis'
import z from '@hydra1902/schemastery'
import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsConflictError, settingsNamespace } from '@hydra1902/harness-settings'
import { FileSettingsProvider } from '../src/index.ts'

const AlphaSchema: z<{ value: number }> = z.object({ value: z.number().default(0) })
const BetaSchema: z<{ value: number }> = z.object({ value: z.number().default(0) })

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hydra-settings-lock-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof FileSettingsProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(FileSettingsProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('cross-instance writes', () => {
  it.each(['yaml', 'json'])('preserves reset preferences and array removals when a stale writer changes another field (%s)', async (format) => {
    const path = join(await tempDir(), `settings.${format}`)
    const ns = settingsNamespace('preferences')
    const schema = z.object({
      theme: z.string().default('system'), enabled: z.boolean().default(true),
      names: z.array(z.string()).default([]), timeout: z.number().default(1000),
    })
    const first = await boot({ path, watch: false })
    first.settings.register(ns, schema)
    await first.settings.update(ns, { theme: 'dark', enabled: false, names: ['removed', 'kept'] })
    const second = await boot({ path, watch: false })
    const scope = second.settings.register(ns, schema)
    await first.settings.mutate(ns, [
      { op: 'unset', path: ['theme'] }, { op: 'unset', path: ['enabled'] },
      { op: 'set', path: ['names'], value: ['kept'] },
    ])
    await second.settings.update(ns, { timeout: 2000 })
    expect(scope.get()).toEqual({ theme: 'system', enabled: true, names: ['kept'], timeout: 2000 })
    expect(second.settings.describe()[0]?.user).toEqual({ names: ['kept'], timeout: 2000 })
    const restarted = await boot({ path, watch: false })
    expect(restarted.settings.register(ns, schema).get()).toEqual(scope.get())
  })

  it.each(['yaml', 'json'].flatMap(format => ['update', 'mutate'].map(mode => ({ format, mode }))))(
    'keeps a deleted provider absent when a stale writer edits a sibling ($format, $mode)', async ({ format, mode }) => {
      const path = join(await tempDir(), `settings.${format}`)
      const ns = settingsNamespace('llm-pi-ai')
      const schema = z.object({ providers: z.dict(z.object({ baseURL: z.string() })) })
      const first = await boot({ path, watch: false })
      first.settings.register(ns, schema)
      await first.settings.update(ns, {
        providers: {
          experientiallabs: { baseURL: 'https://removed.example/v1' },
          xpiki: { baseURL: 'https://kept.example/v1' },
        },
      })
      // No watcher: the second writer must reconcile while holding the file lock.
      const second = await boot({ path, watch: false })
      const secondScope = second.settings.register(ns, schema)
      await first.settings.mutate(ns, [{ op: 'unset', path: ['providers', 'experientiallabs'] }])
      if (mode === 'update') {
        await second.settings.update(ns, { providers: { xpiki: { baseURL: 'https://updated.example/v1' } } })
      } else {
        await second.settings.mutate(ns, [{
          op: 'set', path: ['providers', 'xpiki', 'baseURL'], value: 'https://updated.example/v1',
        }])
      }

      const expected = { providers: { xpiki: { baseURL: 'https://updated.example/v1' } } }
      expect(secondScope.get()).toEqual(expected)
      expect(await readFile(path, 'utf8')).not.toContain('experientiallabs')
      const restarted = await boot({ path, watch: false })
      expect(restarted.settings.register(ns, schema).get()).toEqual(expected)
    })

  it.each(['update', 'replace', 'mutate'] as const)('rejects a stale %s revision before overwriting an unseen file edit', async (mode) => {
    const path = join(await tempDir(), 'settings.yaml')
    const ns = settingsNamespace('alpha')
    const first = await boot({ path, watch: false })
    const second = await boot({ path, watch: false })
    first.settings.register(ns, AlphaSchema)
    const scope = second.settings.register(ns, AlphaSchema)
    const revision = second.settings.describe()[0]!.revision
    await first.settings.update(ns, { value: 7 })
    const stored = await readFile(path, 'utf8')
    const write = mode === 'mutate'
      ? second.settings.mutate(ns, [{ op: 'set', path: ['value'], value: 9 }], revision)
      : second.settings[mode](ns, { value: 9 }, revision)

    await expect(write).rejects.toBeInstanceOf(SettingsConflictError)
    expect(await readFile(path, 'utf8')).toBe(stored)
    expect(scope.get()).toEqual({ value: 7 })
    await second.settings.update(ns, { value: 11 }, second.settings.describe()[0]!.revision)
    expect(scope.get()).toEqual({ value: 11 })
  })

  it('keeps both namespaces when two providers write the same document concurrently', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const first = await boot({ path, watch: false })
    const second = await boot({ path, watch: false })
    const alpha = first.settings.register(settingsNamespace('alpha'), AlphaSchema)
    const beta = second.settings.register(settingsNamespace('beta'), BetaSchema)
    const rounds = [1, 2, 3, 4, 5]
    await Promise.all([
      (async () => { for (const value of rounds) await alpha.update({ value }) })(),
      (async () => { for (const value of rounds) await beta.update({ value }) })(),
    ])
    const text = await readFile(path, 'utf8')
    expect(text).toContain('alpha:')
    expect(text).toContain('beta:')
    // A third instance resolves both final values from the shared document.
    const third = await boot({ path, watch: false })
    expect(third.settings.register(settingsNamespace('alpha'), AlphaSchema).get()).toEqual({ value: 5 })
    expect(third.settings.register(settingsNamespace('beta'), BetaSchema).get()).toEqual({ value: 5 })
  })
})

describe('writer lock', () => {
  it('waits for a busy writer lock instead of failing', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    await writeFile(`${path}.lock`, 'holder\n')
    const release = setTimeout(() => { void rm(`${path}.lock`, { force: true }) }, 120)
    cleanups.push(async () => { clearTimeout(release) })
    await scope.update({ value: 7 })
    expect(await readFile(path, 'utf8')).toContain('value: 7')
  })

  it('does not steal an old writer lock', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'alpha:\n  value: 4\n')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    const lockPath = `${path}.lock`
    await writeFile(lockPath, 'slow-holder\n')
    const past = (Date.now() - 60_000) / 1000
    await utimes(lockPath, past, past)

    await expect(scope.update({ value: 9 })).rejects.toThrow(/timed out waiting for the writer lock/)
    expect(await readFile(path, 'utf8')).toContain('value: 4')
    expect(await readFile(lockPath, 'utf8')).toBe('slow-holder\n')
  }, 10_000)

  it.skipIf(process.platform === 'win32')('surfaces a non-contention lock failure as the write error', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    await chmod(dir, 0o500)
    cleanups.push(() => chmod(dir, 0o700))
    await expect(scope.update({ value: 1 })).rejects.toThrow(/EACCES|permission/)
  })
})
