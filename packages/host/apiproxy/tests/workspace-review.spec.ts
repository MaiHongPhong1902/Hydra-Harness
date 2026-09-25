import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readWorkspaceReview, resolveReviewLimits } from '../src/workspace-review.ts'
import { reviewWorkspaceRequestSchema } from '../src/api/review.schema.ts'

const run = promisify(execFile)
const roots: string[] = []
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args], { encoding: 'utf8' })

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hydra-review-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await git(root, 'config', 'user.email', 'test@example.invalid')
  await git(root, 'config', 'user.name', 'Review Test')
  await writeFile(join(root, 'tracked.txt'), 'before\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-qm', 'initial')
  return root
}

describe('readWorkspaceReview', () => {
  it('reviews an unborn repository and rejects comparisons that require commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-review-'))
    roots.push(root)
    await git(root, 'init', '-q')
    await writeFile(join(root, 'empty'), '')
    await writeFile(join(root, 'no-newline'), 'content')
    await writeFile(join(root, 'invalid'), Buffer.from([0xff]))
    await git(root, 'add', 'empty')
    const result = await readWorkspaceReview(root, { mode: 'uncommitted' }, resolveReviewLimits({}))
    expect(result.files.find(file => file.path === 'empty')?.hunks).toEqual([])
    expect(result.files.find(file => file.path === 'no-newline')?.hunks[0]?.lines).toEqual(['+content', '\\ No newline at end of file'])
    expect(result.files.find(file => file.path === 'invalid')?.binary).toBe(true)
    for (const mode of ['branch', 'committed'] as const) {
      await expect(readWorkspaceReview(root, { mode }, resolveReviewLimits({}))).rejects.toThrow('no commits')
    }
  })

  it('compares non-root commits, uses configured upstream and reads detached HEAD', async () => {
    const root = await repository()
    await git(root, 'branch', 'review-base')
    await git(root, 'branch', '--set-upstream-to=review-base')
    await writeFile(join(root, 'tracked.txt'), 'after\n')
    await git(root, 'commit', '-qam', 'second')
    const limits = resolveReviewLimits({})
    const commit = await readWorkspaceReview(root, { mode: 'committed', ref: 'HEAD', fullContext: true }, limits)
    expect(commit.baseRef).toBe('HEAD')
    expect(commit.files[0]).toMatchObject({ additions: 1, deletions: 1 })
    expect((await readWorkspaceReview(root, { mode: 'branch' }, limits)).baseRef).toBe('refs/heads/review-base')
    await git(root, 'checkout', '--detach', '-q')
    expect((await readWorkspaceReview(root, { mode: 'committed' }, limits)).branch).toBeNull()
    await expect(readWorkspaceReview(root, { mode: 'branch' }, limits)).rejects.toThrow('Select a base branch')
    const detached = await readWorkspaceReview(root, { mode: 'branch', ref: 'refs/heads/review-base' }, limits)
    expect(detached).toMatchObject({ branch: null, baseRef: 'refs/heads/review-base' })
    expect(detached.files[0]).toMatchObject({ additions: 1, deletions: 1 })
    await expect(readWorkspaceReview(root, { mode: 'committed', ref: 'missing' }, limits)).rejects.toThrow('Git could not read')
  }, 30_000)

  it('counts deleted and binary tracked files and bounds tracked comparisons', async () => {
    const root = await repository()
    await writeFile(join(root, 'binary'), Buffer.from([0, 1]))
    await git(root, 'add', '.')
    await git(root, 'commit', '-qm', 'binary')
    await writeFile(join(root, 'binary'), Buffer.from([0, 2]))
    await rm(join(root, 'tracked.txt'))
    const result = await readWorkspaceReview(root, { mode: 'uncommitted' }, resolveReviewLimits({}))
    expect(result.files.find(file => file.path === 'binary')).toMatchObject({ binary: true, patch: null })
    expect(result.files.find(file => file.path === 'tracked.txt')).toMatchObject({ status: 'deleted', deletions: 1 })
    const limited = await readWorkspaceReview(root, { mode: 'uncommitted' }, resolveReviewLimits({ reviewMaxFiles: 1 }))
    expect(limited.files).toHaveLength(1)
    expect(limited.truncated).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('preserves executable mode for untracked files', async () => {
    const root = await repository()
    await writeFile(join(root, 'run.sh'), 'echo yes\n')
    await chmod(join(root, 'run.sh'), 0o755)
    const result = await readWorkspaceReview(root, { mode: 'unstaged' }, resolveReviewLimits({}))
    expect(result.files[0]?.patch).toContain('new file mode 100755')
  })

  it('rejects client-supplied paths and invalid budgets', () => {
    expect(reviewWorkspaceRequestSchema.safeParse({ sessionId: 'owner', mode: 'unstaged', cwd: '/another-project' }).success).toBe(false)
    for (const key of ['reviewMaxBytes', 'reviewMaxFiles', 'reviewTimeoutMs']) {
      for (const value of [0, -1, 1.5, Infinity]) expect(() => resolveReviewLimits({ [key]: value })).toThrow('positive integer')
    }
  })
  it('reads staged, unstaged, and untracked changes from the supplied workspace', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'before\nafter\n')
    await writeFile(join(root, 'staged.txt'), 'staged\n')
    await git(root, 'add', 'staged.txt')
    await writeFile(join(root, 'untracked.txt'), 'new\n')
    const limits = resolveReviewLimits({ reviewTimeoutMs: 5000 })
    const unstaged = await readWorkspaceReview(root, { mode: 'unstaged' }, limits)
    expect(unstaged.files.map(file => file.path)).toEqual(expect.arrayContaining(['tracked.txt', 'untracked.txt']))
    expect(unstaged.files.find(file => file.path === 'untracked.txt')?.status).toBe('added')
    const staged = await readWorkspaceReview(root, { mode: 'staged' }, limits)
    expect(staged.files.map(file => file.path)).toEqual(['staged.txt'])
  })

  it('returns no repository for a plain folder and rejects invalid refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-review-'))
    roots.push(root)
    expect((await readWorkspaceReview(root, { mode: 'uncommitted' }, resolveReviewLimits({}))).repository).toBeNull()
    const repo = await repository()
    await expect(readWorkspaceReview(repo, { mode: 'committed', ref: '--bad' }, resolveReviewLimits({}))).rejects.toThrow('Invalid review reference')
  })

  it('bounds the number of files', async () => {
    const root = await repository()
    await writeFile(join(root, 'one.txt'), 'one\n')
    await writeFile(join(root, 'two.txt'), 'two\n')
    const result = await readWorkspaceReview(root, { mode: 'uncommitted' }, resolveReviewLimits({ reviewMaxFiles: 1 }))
    expect(result.files).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('compares root commits and branches and restricts nested sessions to their cwd', async () => {
    const root = await repository()
    const limits = resolveReviewLimits({})
    const initial = await readWorkspaceReview(root, { mode: 'committed' }, limits)
    expect(initial.files.map(file => file.path)).toEqual(['tracked.txt'])
    await git(root, 'branch', 'review-base')
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'inside.txt'), 'inside\n')
    await writeFile(join(root, 'outside.txt'), 'outside\n')
    await git(root, 'add', '.')
    await git(root, 'commit', '-qm', 'nested changes')
    const comparison = await readWorkspaceReview(join(root, 'nested'), { mode: 'branch', ref: 'refs/heads/review-base' }, limits)
    expect(comparison.files.map(file => file.path)).toEqual(['inside.txt'])
    expect(comparison.files[0]?.hunks[0]?.lines).toEqual(['+inside'])
    expect(comparison.branches).toContain('refs/heads/review-base')
    expect(comparison.commits[0]?.subject).toBe('nested changes')
  }, 30_000)

  it('bounds the whole response, reports binary and oversized files, and honors cancellation', async () => {
    const root = await repository()
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(root, 'large.txt'), 'x'.repeat(5000))
    const result = await readWorkspaceReview(root, { mode: 'uncommitted' }, resolveReviewLimits({ reviewMaxBytes: 2000 }))
    expect(result.files.find(file => file.path === 'binary.dat')).toMatchObject({ binary: true, patch: null })
    expect(result.files.find(file => file.path === 'large.txt')).toMatchObject({ truncated: true, patch: null })
    await expect(readWorkspaceReview(root, { mode: 'uncommitted' }, resolveReviewLimits({ reviewMaxBytes: 10 }))).rejects.toThrow('byte limit')
    await expect(readWorkspaceReview(root, { mode: 'uncommitted' }, resolveReviewLimits({}), AbortSignal.abort())).rejects.toThrow()
  })
})
