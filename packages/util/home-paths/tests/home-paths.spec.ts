import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BH_HOME_DISPLAY,
  BH_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultBhHome,
  bhHomeDisplay,
  bhHomePath,
  expandHomePath,
  resolveBhHome,
} from '@bosch/bh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('bh path helpers', () => {
  it('owns the shared default BH home directory name', () => {
    expect(BH_HOME_DIR_NAME).toBe('.bh')
    expect(DEFAULT_BH_HOME_DISPLAY).toBe('~/.bh')
    expect(defaultBhHome()).toBe(join(homedir(), '.bh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.bh')).toBe(join(homedir(), '.bh'))
    expect(expandHomePath('~\\.bh')).toBe(join(homedir(), '.bh'))
    expect(expandHomePath('/tmp/.bh')).toBe('/tmp/.bh')
    expect(expandHomePath('~other/.bh')).toBe('~other/.bh')
  })

  it('resolves explicit path before BH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-bh')

    expect(resolveBhHome('/tmp/explicit-bh', { BH_HOME: '~/env-bh' })).toBe(resolve('/tmp/explicit-bh'))
    expect(resolveBhHome(undefined, { BH_HOME: '~/env-bh' })).toBe(envHome)
    expect(resolveBhHome(undefined, {})).toBe(defaultBhHome())
  })

  it('treats an empty or whitespace-only BH_HOME as unset', () => {
    expect(resolveBhHome(undefined, { BH_HOME: '' })).toBe(defaultBhHome())
    expect(resolveBhHome(undefined, { BH_HOME: '   ' })).toBe(defaultBhHome())
  })

  it('joins child segments onto the resolved BH_HOME', () => {
    vi.stubEnv('BH_HOME', '~/env-bh')
    expect(bhHomePath()).toBe(join(homedir(), 'env-bh'))
    expect(bhHomePath('storages', 'cache')).toBe(join(homedir(), 'env-bh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(bhHomeDisplay(resolve(defaultBhHome()))).toBe('~/.bh')
    expect(bhHomeDisplay('/some/other/root')).toBe('$BH_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bh-watch-path-'))
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
