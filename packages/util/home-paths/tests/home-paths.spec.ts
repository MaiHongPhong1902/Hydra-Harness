import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HYDRA_HOME_DISPLAY,
  HYDRA_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultHydraHome,
  hydraHomeDisplay,
  hydraHomePath,
  expandHomePath,
  resolveHydraHome,
} from '@hydraharness/harness-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('hydra path helpers', () => {
  it('owns the shared default Hydra home directory name', () => {
    expect(HYDRA_HOME_DIR_NAME).toBe('.hydra')
    expect(DEFAULT_HYDRA_HOME_DISPLAY).toBe('~/.hydra')
    expect(defaultHydraHome()).toBe(join(homedir(), '.hydra'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.hydra')).toBe(join(homedir(), '.hydra'))
    expect(expandHomePath('~\\.hydra')).toBe(join(homedir(), '.hydra'))
    expect(expandHomePath('/tmp/.hydra')).toBe('/tmp/.hydra')
    expect(expandHomePath('~other/.hydra')).toBe('~other/.hydra')
  })

  it('resolves explicit path before HYDRA_HOME and the default', () => {
    const envHome = join(homedir(), 'env-hydra')

    expect(resolveHydraHome('/tmp/explicit-hydra', { HYDRA_HOME: '~/env-hydra' })).toBe(resolve('/tmp/explicit-hydra'))
    expect(resolveHydraHome(undefined, { HYDRA_HOME: '~/env-hydra' })).toBe(envHome)
    expect(resolveHydraHome(undefined, {})).toBe(defaultHydraHome())
  })

  it('treats an empty or whitespace-only HYDRA_HOME as unset', () => {
    expect(resolveHydraHome(undefined, { HYDRA_HOME: '' })).toBe(defaultHydraHome())
    expect(resolveHydraHome(undefined, { HYDRA_HOME: '   ' })).toBe(defaultHydraHome())
  })

  it('joins child segments onto the resolved HYDRA_HOME', () => {
    vi.stubEnv('HYDRA_HOME', '~/env-hydra')
    expect(hydraHomePath()).toBe(join(homedir(), 'env-hydra'))
    expect(hydraHomePath('storages', 'cache')).toBe(join(homedir(), 'env-hydra', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(hydraHomeDisplay(resolve(defaultHydraHome()))).toBe('~/.hydra')
    expect(hydraHomeDisplay('/some/other/root')).toBe('$HYDRA_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
