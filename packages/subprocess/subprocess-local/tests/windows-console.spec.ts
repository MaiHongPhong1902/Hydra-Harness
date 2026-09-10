/** Background commands and their cleanup must not create external Windows consoles. */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { spawnSubprocess, taskkillProcessTree } from '../src/spawn.ts'
import { createWindowsProcessInspector } from '../src/windows-inspector.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) }
})

describe('background process windows', () => {
  it('hides ordinary commands while collecting their output', async () => {
    const running = spawnSubprocess({
      argv: [process.execPath, '-e', 'console.log("hello")'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } },
      graceMs: 100,
    })
    await expect(running.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(running.collected.stdout?.readFrom(0).text).toBe('hello\n')
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.windowsHide).toBe(true)
  })

  it('hides ordinary tree cleanup', () => {
    taskkillProcessTree(2 ** 30)
    expect(spawnSync).toHaveBeenLastCalledWith('taskkill', ['/PID', String(2 ** 30), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    })
  })

  it.each(['SIGTERM', 'SIGKILL'] as const)('hides terminal tree cleanup for %s', (signal) => {
    createWindowsProcessInspector().signalGroup(2 ** 30, signal)
    expect(spawnSync).toHaveBeenLastCalledWith('taskkill', [
      '/PID', String(2 ** 30), '/T', ...(signal === 'SIGKILL' ? ['/F'] : []),
    ], { stdio: 'ignore', windowsHide: true })
  })

  it.skipIf(process.platform !== 'win32')('creates no console when the host has none', () => {
    const require = createRequire(import.meta.url)
    const probe = `const koffi = require(${JSON.stringify(require.resolve('koffi'))});
      console.log(koffi.load('kernel32.dll').func('void* __stdcall GetConsoleWindow()')() === null);`
    const host = `import { createRequire } from 'node:module';
      import { spawnSubprocess } from ${JSON.stringify(new URL('../src/spawn.ts', import.meta.url).href)};
      createRequire(import.meta.url)(${JSON.stringify(require.resolve('koffi'))}).load('kernel32.dll').func('int __stdcall FreeConsole()')();
      const child = spawnSubprocess(${JSON.stringify({
        argv: [process.execPath, '-e', probe], cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } }, graceMs: 100,
      })});
      const result = await child.done;
      process.stdout.write(child.collected.stdout.readFrom(0).text);
      process.stderr.write(child.collected.stderr.readFrom(0).text);
      process.exitCode = result.exitCode ?? 1;`
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', host], {
      windowsHide: true, encoding: 'utf8', timeout: 10_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('true\n')
  })
})
