import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readWorkspaceReview, resolveReviewLimits } from '../src/workspace-review.ts'

const io = vi.hoisted(() => ({ git: vi.fn(), lstat: vi.fn(), realpath: vi.fn(), open: vi.fn() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), {
    [promisify.custom]: (_command: string, args: string[]) => {
      const child = new EventEmitter()
      const pending = io.git(args) as Promise<{ stdout: string }>
      void pending.then(() => { setImmediate(() => child.emit('close')) }, () => { setImmediate(() => child.emit('close')) })
      return Object.assign(pending, { child })
    },
  }),
}))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(),
  lstat: io.lstat, realpath: io.realpath, open: io.open }))

const workspace = resolve('review-fixture')
const handle = { stat: vi.fn(), read: vi.fn(), close: vi.fn() }
const limits = resolveReviewLimits({ reviewMaxBytes: 4096 })
let diff = ''
let paths = 'a.txt\0'

beforeEach(() => {
  vi.resetAllMocks()
  diff = ''; paths = 'a.txt\0'
  io.realpath.mockImplementation(async (path: string) => path)
  io.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 0, mode: 0o755 })
  handle.stat.mockResolvedValue({ isFile: () => true })
  handle.read.mockImplementation(async (buffer: Buffer) => { buffer.write('A'); return { bytesRead: 1 } })
  handle.close.mockResolvedValue(undefined)
  io.open.mockResolvedValue(handle)
  io.git.mockImplementation(async (args: string[]) => {
    if (args.includes('--show-toplevel')) return { stdout: workspace }
    if (args.includes('symbolic-ref')) return { stdout: 'main' }
    if (args.includes('rev-parse')) return { stdout: 'a'.repeat(40) }
    if (args.includes('diff')) return { stdout: diff }
    if (args.includes('ls-files')) return { stdout: paths }
    return { stdout: '' }
  })
})

describe('workspace review process and filesystem failures', () => {
  it.each([['ENOENT', 'Git is not installed'], [undefined, 'Git could not read']])('reports Git launch failure %s', async (code, message) => {
    io.git.mockRejectedValueOnce(Object.assign(new Error('failed'), { code }))
    await expect(readWorkspaceReview(workspace, { mode: 'unstaged' }, limits)).rejects.toThrow(message)
  })

  it.each(['invalid', ':100644 100644 abc def M\0a\0\0'])('rejects malformed Git diff metadata', async (output) => {
    diff = output
    await expect(readWorkspaceReview(workspace, { mode: 'unstaged' }, limits)).rejects.toThrow(/unsupported diff|merge conflicts/)
  })

  it('rejects paths escaping the session workspace before opening a file', async () => {
    paths = '../outside\0'
    await expect(readWorkspaceReview(workspace, { mode: 'unstaged' }, limits)).rejects.toThrow('outside the session workspace')
    expect(io.open).not.toHaveBeenCalled()
  })

  it('rejects a file whose resolved path moved outside the session workspace', async () => {
    io.realpath.mockResolvedValueOnce(workspace).mockResolvedValueOnce(resolve('outside'))
    await expect(readWorkspaceReview(workspace, { mode: 'unstaged' }, limits)).rejects.toThrow('resolves outside')
    expect(io.open).not.toHaveBeenCalled()
  })

  it('reports nonregular files without reading them', async () => {
    io.lstat.mockResolvedValueOnce({ isFile: () => false })
    expect((await readWorkspaceReview(workspace, { mode: 'unstaged' }, limits)).files[0]?.binary).toBe(true)
    expect(io.open).not.toHaveBeenCalled()
  })

  it('closes a handle whose file type changed after lstat', async () => {
    handle.stat.mockResolvedValueOnce({ isFile: () => false })
    expect((await readWorkspaceReview(workspace, { mode: 'unstaged' }, limits)).files[0]?.binary).toBe(true)
    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('bounds files that grow between lstat and read', async () => {
    handle.read.mockResolvedValueOnce({ bytesRead: limits.reviewMaxBytes + 1 })
    expect((await readWorkspaceReview(workspace, { mode: 'unstaged' }, limits)).files[0]?.truncated).toBe(true)
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('retains executable mode in an untracked patch', async () => {
    expect((await readWorkspaceReview(workspace, { mode: 'unstaged' }, limits)).files[0]?.patch).toContain('new file mode 100755')
  })

  it('bounds the complete response even when individual Git commands fit', async () => {
    io.git.mockResolvedValue({ stdout: '' })
    await expect(readWorkspaceReview(workspace, { mode: 'unstaged' }, { ...limits, reviewMaxBytes: 1 })).rejects.toThrow('byte limit')
  })
})
