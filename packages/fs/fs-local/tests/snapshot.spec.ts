import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LocalFileSystem from '../src/index.ts'
import { snapshotFile } from '../src/fsio.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

let dir: string
let fs: LocalFileSystem
let testCtx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hydra-snapshot-'))
  testCtx = new Context()
  fiber = await testCtx.plugin(LocalFileSystem, { cwd: dir })
  fs = testCtx.fs as LocalFileSystem
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('raw snapshots and guarded restoration', () => {
  it('distinguishes absence from empty content and streams hashes beyond the retention cap', async () => {
    const path = join(dir, 'file')
    expect(await snapshotFile(path, 0)).toEqual({ hash: null, bytes: null })
    await writeFile(path, '')
    expect(await snapshotFile(path, 0)).toEqual({ hash: hash(Buffer.alloc(0)), bytes: Buffer.alloc(0) })
    const bytes = Buffer.alloc(130_000, 255)
    await writeFile(path, bytes)
    expect(await snapshotFile(path, bytes.length)).toEqual({ hash: hash(bytes), bytes })
    expect(await snapshotFile(path, bytes.length - 1)).toEqual({ hash: hash(bytes), bytes: null })
    expect(await snapshotFile(path, 0)).toEqual({ hash: hash(bytes), bytes: null })
  })

  it('rejects directories and directory links without following them', async () => {
    await expect(snapshotFile(dir, 10)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    const link = join(dir, 'link')
    await symlink(dir, link, 'junction')
    await expect(snapshotFile(link, 10)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await unlink(link)
  })

  it('rejects an opened file replaced before snapshot validation', async () => {
    const path = join(dir, 'file')
    await writeFile(path, 'old')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementation(async (target, flags, mode) => {
      const handle = await actual.open(target, flags, mode)
      if (target === path) {
        await unlink(path)
        await writeFile(path, 'new')
      }
      return handle
    })
    await expect(snapshotFile(path, 10)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readFile(path, 'utf8')).toBe('new')
  })

  it('restores exact binary bytes and deleted files without generating another mutation event', async () => {
    const target = await fs.resolve('file')
    const bytes = Buffer.from([0, 255, 13, 10, 4])
    const mutations: string[] = []
    const dispose = testCtx.on('fs/mutate', async (_target, operation, next) => { mutations.push(operation); return next() })
    await fs.writeText(target, 'after')
    expect(await fs.restoreSnapshot(target, bytes, hash(Buffer.from('after')))).toBe(true)
    expect(await readFile(join(dir, 'file'))).toEqual(bytes)
    expect(mutations).toEqual(['write'])
    await unlink(join(dir, 'file'))
    expect(await fs.restoreSnapshot(target, bytes, null)).toBe(true)
    expect(await readFile(join(dir, 'file'))).toEqual(bytes)
    dispose()
  })

  it('removes a matching creation and leaves absent targets absent', async () => {
    const target = await fs.resolve('file')
    await fs.writeText(target, 'after')
    expect(await fs.restoreSnapshot(target, null, hash(Buffer.from('after')))).toBe(true)
    expect(await fs.restoreSnapshot(target, null, null)).toBe(true)
    await expect(readFile(join(dir, 'file'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses mismatched bytes or existence and a competing writer at publication', async () => {
    const target = await fs.resolve('file')
    const bytes = Buffer.from('before')
    await fs.writeText(target, 'external')
    expect(await fs.restoreSnapshot(target, bytes, hash(Buffer.from('after')))).toBe(false)
    expect(await fs.restoreSnapshot(target, bytes, null)).toBe(false)
    await fs.writeText(target, 'after')
    fs.internals.inspectTemp = async () => { await writeFile(join(dir, 'file'), 'racing editor') }
    expect(await fs.restoreSnapshot(target, bytes, hash(Buffer.from('after')))).toBe(false)
    expect(await readFile(join(dir, 'file'), 'utf8')).toBe('racing editor')
    await unlink(join(dir, 'file'))
    expect(await fs.restoreSnapshot(target, bytes, null)).toBe(false)
    expect(await readFile(join(dir, 'file'), 'utf8')).toBe('racing editor')
  })

  it('propagates publication failures and keeps the previous bytes', async () => {
    const target = await fs.resolve('file')
    await fs.writeText(target, 'after')
    fs.internals.inspectTemp = async () => { throw new Error('staging failed') }
    await expect(fs.restoreSnapshot(target, Buffer.from('before'), hash(Buffer.from('after')))).rejects.toThrow('staging failed')
    expect(await readFile(join(dir, 'file'), 'utf8')).toBe('after')
    await mkdir(join(dir, 'directory'))
    await expect(fs.restoreSnapshot(await fs.resolve('directory'), null, null)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
})
