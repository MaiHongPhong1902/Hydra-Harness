import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Keyless smoke for SOURCE `hydra` execution: run `apps/cli/src/bin.ts`
 * with the exact production runtime vector (`node --import tsx/esm`, the
 * vector the root `hydra` script invokes directly) and assert the
 * deterministic non-interactive bare-launcher diagnostic. The Node
 * compatibility matrix runs this WHOLE file, so a Node release changing
 * module hooks or TypeScript handling breaks this gate instead of every
 * developer's `pnpm hydra`; the built-bin suite covers the published `lib/`
 * entry, not this source chain.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const hydraSourceBin = 'apps/cli/src/bin.ts'

describe('hydra SOURCE launcher (node --import tsx/esm)', () => {
  it('launches the source CLI without building', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.hydra).toBe('node --import tsx/esm apps/cli/src/bin.ts')
  })

  it('prints explicit commands for a non-interactive bare launch', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', hydraSourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
      env: { ...process.env, CI: '1' },
    })
    if (result.timedOut) {
      throw new Error(`hydra source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('requires an interactive terminal')
    expect(result.stderr).toContain('npx @hydra1902/harness web')
    expect(result.stdout).toBe('')
  }, 30_000)
})
