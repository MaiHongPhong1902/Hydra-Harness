import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra1902/cordis'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import SessionStore, { SessionId, type Session } from '@hydra1902/harness-session'
import JsonlSessionPersistence from '@hydra1902/harness-session-persistence-jsonl'
import { CallId } from '@hydra1902/harness-llm'
import ToolRuntime, { type ToolDispatchExecution } from '@hydra1902/harness-tools'
import SystemPrompt from '@hydra1902/harness-system-prompt'
import LocalFileSystem from '@hydra1902/harness-fs-local'
import * as ToolFs from '@hydra1902/harness-tool-fs'
import FileReview, { type Config } from '../src/index.ts'
import SandboxPolicyService from '@hydra1902/harness-sandbox-policy'
import { FsError } from '@hydra1902/harness-fs'
import type { ChangeId } from '../src/types.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

let ctx: Context
let dir: string
let workspace: string
let session: Session
let counter = 0
let fibers: Awaited<ReturnType<Context['plugin']>>[] = []
const owner = SessionId('review-owner')

async function mount(snapshotMaxBytes = 16 * 1024 * 1024, options: Config = {}) {
  ctx = new Context()
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(dir, 'sessions'), compression: 'none' }))
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(LocalFileSystem, { cwd: workspace }))
  fibers.push(await ctx.plugin(ToolFs))
  fibers.push(await ctx.plugin(FileReview, { directory: join(dir, 'review'), snapshotMaxBytes, ...options }))
}

async function close() {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  fibers = []
}

async function call(name: string, args: unknown) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal, callId: CallId(`call-${++counter}`), name,
    arguments: args, agent: { session } as never,
  })
  if (result.isError) throw new Error(JSON.stringify(result))
  return (await ctx.fileReview.list(owner)).at(-1)!
}

function snapshotPath(id: ChangeId, file: string) {
  return join(dir, 'review', createHash('sha256').update(owner).digest('hex'), id, file)
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'hydra-review-')))
  workspace = join(dir, 'workspace')
  await mkdir(workspace)
  await mount()
  session = ctx.sessions.create(owner, { meta: { cwd: workspace } })
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await close(); await rm(dir, { recursive: true, force: true }) })

describe('PI-derived review behavior', () => {
  it('resolves direct-construction defaults and rejects relative storage', async () => {
    await close()
    vi.stubEnv('HYDRA_HOME', join(dir, 'home'))
    ctx = new Context()
    const service = new FileReview(ctx, {})
    expect(service.config).toEqual({ directory: join(dir, 'home', 'review-changes'), snapshotMaxBytes: 16 * 1024 * 1024, diffMaxBytes: 512 * 1024, diffMaxLines: 4000, diffMaxCells: 2_000_000 })
    await ctx.fiber.dispose()
    const invalid = new Context()
    expect(() => new FileReview(invalid, { directory: 'relative' })).toThrow('must be absolute')
    await invalid.fiber.dispose()
  })

  it('ignores mutations without a workspace agent or structured Write/Edit identity', async () => {
    const target = await ctx.fs.resolve('untracked.txt')
    await ctx.fs.writeText(target, 'direct')
    const noCwd = ctx.sessions.create(SessionId('without-cwd'))
    for (const [name, agent] of [['write', undefined], ['write', { session: noCwd }], ['shell', { session }]] as const) {
      const exec = { name, agent, signal: new AbortController().signal, callId: CallId('untracked'), rootCallId: CallId('untracked'), arguments: {}, token: {} } as ToolDispatchExecution
      await ctx.waterfall('tools/execute', exec, async () => {
        await ctx.fs.writeText(target, name)
        return { isError: false, value: null, content: [] }
      })
    }
    expect(await ctx.fileReview.list(owner)).toEqual([])
    expect(await readFile(join(workspace, 'untracked.txt'), 'utf8')).toBe('shell')
  })

  it('excludes external paths and the workspace root and rejects storage within the workspace', async () => {
    expect(await call('write', { file_path: join(dir, 'outside.txt'), content: 'outside' })).toBeUndefined()
    await expect(call('write', { file_path: workspace, content: 'root' })).rejects.toThrow()
    expect(await ctx.fileReview.list(owner)).toEqual([])
    await close()
    await mount(undefined, { directory: join(workspace, 'review') })
    session = ctx.sessions.create(owner, { meta: { cwd: workspace } })
    await expect(call('write', { file_path: 'a.txt', content: 'A' })).rejects.toThrow('outside the workspace')
    await expect(readFile(join(workspace, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('captures turn/step attribution and orders equal-time changes deterministically', async () => {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const first = await call('write', { file_path: 'a.txt', content: 'A' })
    const second = await call('write', { file_path: 'a.txt', content: 'B' })
    expect(first).toMatchObject({ turnSeq: 0, stepSeq: 1, seq: 2 })
    await writeFile(snapshotPath(second.id, 'meta.json'), JSON.stringify({ ...second, createdAt: first.createdAt }))
    expect((await ctx.fileReview.list(owner)).map(change => change.id)).toEqual([first.id, second.id].sort((a, b) => a.localeCompare(b)))
    session.append('step/start', { turn: 1, step: 2 })
    expect((await call('write', { file_path: 'a.txt', content: 'C' })).stepSeq).toBe(2)
    session = ctx.sessions.create(SessionId('orphan-child'), { meta: { cwd: workspace, origin: 'subagent' } })
    await call('write', { file_path: 'child.txt', content: 'child' })
    expect((await ctx.fileReview.list(session.id))[0]?.parentSessionId).toBeNull()
  })

  it('preserves pending evidence if a provider fails after publishing', async () => {
    const dispose = ctx.on('fs/mutate', async (_target, _operation, next) => { await next(); throw new Error('failed after publication') })
    await expect(call('write', { file_path: 'a.txt', content: 'B' })).rejects.toThrow('failed after publication')
    dispose()
    const [change] = await ctx.fileReview.list(owner)
    expect(change?.state).toBe('pending')
    expect((await ctx.fileReview.undo(owner, change!.id)).status).toBe('unavailable')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('B')
  })

  it('restores a deletion between mutation and finalization, but cannot restore an absent creation', async () => {
    await writeFile(join(workspace, 'existing'), 'original')
    const dispose = ctx.on('fs/mutate', async (target, _operation, next) => {
      const result = await next()
      await unlink(ctx.fs.processPath(target))
      return result
    })
    const removed = await call('write', { file_path: 'existing', content: 'new' })
    const absent = await call('write', { file_path: 'absent', content: 'new' })
    dispose()
    expect(removed).toMatchObject({ status: 'deleted', afterHash: null, reversible: true, deletions: 1 })
    expect((await ctx.fileReview.undo(owner, removed.id)).status).toBe('rolledBack')
    expect(await readFile(join(workspace, 'existing'), 'utf8')).toBe('original')
    expect(absent).toMatchObject({ status: 'deleted', reversible: false })
    expect((await ctx.fileReview.undo(owner, absent.id)).status).toBe('unavailable')
  })

  it('surfaces storage errors and ignores unrelated entries when sweeping', async () => {
    expect(await ctx.fileReview.list(owner)).toEqual([])
    await ctx.fileReview.sweep()
    await mkdir(join(dir, 'review'))
    const ownerDir = join(dir, 'review', createHash('sha256').update(owner).digest('hex'))
    await writeFile(ownerDir, 'not a directory')
    await expect(ctx.fileReview.list(owner)).rejects.toThrow()
    await mkdir(join(dir, 'review', 'unrelated'))
    await ctx.fileReview.sweep()
    expect(await readFile(ownerDir, 'utf8')).toBe('not a directory')
    await rename(join(dir, 'review'), join(dir, 'saved-review'))
    await writeFile(join(dir, 'review'), 'not a directory')
    await expect(ctx.fileReview.sweep()).rejects.toThrow()
    await expect(ctx.fileReview.undo(owner, '../escape' as ChangeId)).rejects.toThrow('invalid review change id')
  })

  it('skips an uncommitted change directory and surfaces other read failures', async () => {
    const change = await call('write', { file_path: 'a.txt', content: 'B' })
    const uncommitted = snapshotPath('f2b6a8f4-6d6c-4f0a-9a3f-4b1e0a2b6c11' as ChangeId, 'meta.json')
    await mkdir(dirname(uncommitted))
    expect((await ctx.fileReview.list(owner)).map(record => record.id)).toEqual([change.id])
    await writeFile(uncommitted, '{')
    await expect(ctx.fileReview.list(owner)).rejects.toThrow()
  })

  it('rejects a persisted session without its workspace', async () => {
    const change = await call('write', { file_path: 'a.txt', content: 'B' })
    const inspected = await ctx.sessionPersistence.inspect(owner)
    const { cwd: _cwd, ...meta } = inspected.meta
    vi.spyOn(ctx.sessionPersistence, 'inspect').mockResolvedValue({ ...inspected, meta })
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('workspace')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('B')
  })

  it('rejects retargeted directory links and noncanonical metadata paths', async () => {
    const nested = join(workspace, 'nested')
    await mkdir(nested)
    const change = await call('write', { file_path: 'nested/a.txt', content: 'B' })
    await rename(nested, join(dir, 'outside'))
    await symlink(join(dir, 'outside'), nested, 'junction')
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('escaped')
    await unlink(nested)
    await rename(join(dir, 'outside'), nested)
    for (const path of ['.', 'nested/./a.txt']) {
      await writeFile(snapshotPath(change.id, 'meta.json'), JSON.stringify({ ...change, path }))
      await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('changed or escaped')
    }
    expect(await readFile(join(nested, 'a.txt'), 'utf8')).toBe('B')
  })

  it('rejects a snapshot larger than the current restoration limit', async () => {
    await writeFile(join(workspace, 'a.txt'), 'before')
    const change = await call('write', { file_path: 'a.txt', content: 'after' })
    await close()
    await mount(2)
    session = ctx.sessions.create(owner, { meta: { cwd: workspace } })
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('size limit')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('after')
  })

  it.each(['x', 'longer than before'])('rejects a snapshot resized after its stat (%s)', async (replacement) => {
    await writeFile(join(workspace, 'a.txt'), 'before')
    const change = await call('write', { file_path: 'a.txt', content: 'after' })
    const beforePath = snapshotPath(change.id, 'before')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode)
      if (path === beforePath) {
        const info = await handle.stat()
        // Freeze the observed stat, then race the upcoming read with a real file change.
        vi.spyOn(handle, 'stat').mockResolvedValue(info)
        await writeFile(beforePath, replacement)
      }
      return handle
    })
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('changed while reading')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('after')
    expect((await ctx.fileReview.list(owner))[0]?.state).toBe('active')
  })

  it('uses the current session policy and preserves it after restart', async () => {
    fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace }))
    const change = await call('write', { file_path: 'a.txt', content: 'B' })
    const restore = vi.spyOn(ctx.fs, 'restoreSnapshot').mockResolvedValue(false)
    await ctx.fileReview.undo(owner, change.id)
    expect(restore.mock.calls.at(-1)?.[3]).toEqual({ mode: 'workspace-write', workspaceRoot: workspace })
    session.append('sandbox/mode', { mode: 'read-only' })
    await ctx.fileReview.undo(owner, change.id)
    expect(restore.mock.calls.at(-1)?.[3]).toEqual({ mode: 'read-only', workspaceRoot: workspace })
    await ctx.sessions.flush(session)
    restore.mockRestore()
    await close()
    await mount()
    fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: workspace }))
    const coldRestore = vi.spyOn(ctx.fs, 'restoreSnapshot').mockResolvedValue(false)
    await ctx.fileReview.undo(owner, change.id)
    expect(coldRestore.mock.calls.at(-1)?.[3]).toEqual({ mode: 'read-only', workspaceRoot: workspace })
  })

  it('retains uncertain rollback markers when restoration fails unexpectedly', async () => {
    const change = await call('write', { file_path: 'a.txt', content: 'B' })
    vi.spyOn(ctx.fs, 'restoreSnapshot').mockRejectedValue(new FsError('disk failure', 'FS_STALE_VERSION'))
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('disk failure')
    expect((await ctx.fileReview.list(owner))[0]?.state).toBe('undoing')
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('unavailable')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('B')
  })

  it('keeps permission denials retryable and retains evidence after a failed finalization', async () => {
    const change = await call('write', { file_path: 'a.txt', content: 'B' })
    const restore = vi.spyOn(ctx.fs, 'restoreSnapshot').mockRejectedValueOnce(new FsError('read only', 'FS_SANDBOX_DENIED'))
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('read only')
    expect((await ctx.fileReview.list(owner))[0]!.state).toBe('active')
    restore.mockRestore()
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('rolledBack')
    const snapshot = ctx.fs.snapshot.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'snapshot').mockImplementation((target, max) => max === 512 * 1024 ? Promise.reject(new Error('disk unavailable')) : snapshot(target, max))
    await expect(call('write', { file_path: 'a.txt', content: 'C' })).rejects.toThrow()
    const pending = (await ctx.fileReview.list(owner)).at(-1)!
    expect(pending.state).toBe('pending')
    expect((await ctx.fileReview.undo(owner, pending.id)).status).toBe('unavailable')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('C')
    vi.restoreAllMocks()
  })

  it('serializes concurrent agent mutations and preserves runtime child attribution', async () => {
    const child = ctx.sessions.create(SessionId('child'), { meta: { cwd: workspace, parentSession: owner, origin: 'subagent', agentPreset: 'parser-refactor' } })
    const execute = (ownerSession: Session, content: string, id: string) => ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId(id), name: 'write',
      arguments: { file_path: 'shared.txt', content }, agent: { session: ownerSession } as never,
    })
    const results = await Promise.all([execute(session, 'first', 'parent-call'), execute(child, 'second', 'child-call')])
    expect(results.every(result => !result.isError)).toBe(true)
    const parentChange = (await ctx.fileReview.list(owner))[0]!
    const childChange = (await ctx.fileReview.list(child.id))[0]!
    expect(childChange).toMatchObject({ parentSessionId: owner, agentPreset: 'parser-refactor', callId: 'child-call', sessionId: child.id })
    const first = parentChange.beforeHash === null ? parentChange : childChange
    const second = first === parentChange ? childChange : parentChange
    expect(second.beforeHash).toBe(first.afterHash)
    expect((await ctx.fileReview.undo(first.sessionId, first.id)).status).toBe('conflict')
    expect((await ctx.fileReview.undo(second.sessionId, second.id)).status).toBe('rolledBack')
    expect((await ctx.fileReview.undo(first.sessionId, first.id)).status).toBe('rolledBack')
  })

  it('rejects changed workspace and unsafe metadata paths, and removes only orphan session directories', async () => {
    const change = await call('write', { file_path: 'a.txt', content: 'A' })
    await writeFile(snapshotPath(change.id, 'meta.json'), JSON.stringify({ ...change, workspace: join(dir, 'other') }))
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('workspace')
    await writeFile(snapshotPath(change.id, 'meta.json'), JSON.stringify({ ...change, path: '../outside' }))
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow()
    await writeFile(snapshotPath(change.id, 'meta.json'), JSON.stringify(change))
    const orphan = join(dir, 'review', 'f'.repeat(64))
    await mkdir(orphan)
    await ctx.fileReview.sweep()
    await expect(readdir(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await ctx.fileReview.list(owner)).toEqual([change])
  })
  it('creates, keeps, and removes a new file without losing evidence', async () => {
    const change = await call('write', { file_path: 'new.txt', content: 'new\n' })
    expect(change).toMatchObject({ sessionId: owner, status: 'added', additions: 1, deletions: 0, beforeHash: null, reversible: true, toolName: 'write' })
    expect((await ctx.fileReview.keep(owner, change.id)).status).toBe('kept')
    expect(await readFile(join(workspace, 'new.txt'), 'utf8')).toBe('new\n')
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('rolledBack')
    await expect(readFile(join(workspace, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('alreadyRolledBack')
    expect(await ctx.fileReview.list(owner)).toHaveLength(1)
  })

  it('conflicts on an older edit, then undoes in reverse order with exact CRLF bytes', async () => {
    await writeFile(join(workspace, 'a.txt'), 'A\r\n')
    const first = await call('edit', { file_path: 'a.txt', old_string: 'A', new_string: 'B' })
    const second = await call('edit', { file_path: 'a.txt', old_string: 'B', new_string: 'C' })
    expect(first).toMatchObject({ additions: 1, deletions: 1, status: 'modified' })
    expect((await ctx.fileReview.undo(owner, first.id)).status).toBe('conflict')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('C\r\n')
    expect((await ctx.fileReview.undo(owner, second.id)).status).toBe('rolledBack')
    expect((await ctx.fileReview.undo(owner, first.id)).status).toBe('rolledBack')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('A\r\n')
  })

  it('rejects external edits and a writer racing staged rollback publication', async () => {
    await writeFile(join(workspace, 'a.txt'), 'A')
    const change = await call('write', { file_path: 'a.txt', content: 'B' })
    await writeFile(join(workspace, 'a.txt'), 'external')
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('conflict')
    await writeFile(join(workspace, 'a.txt'), 'B')
    ;(ctx.fs as LocalFileSystem).internals.inspectTemp = async () => { await writeFile(join(workspace, 'a.txt'), 'racing editor') }
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('conflict')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('racing editor')
  })

  it('reloads kept evidence and undoes after restarting persistence and review', async () => {
    await writeFile(join(workspace, 'a.txt'), 'A')
    const change = await call('write', { file_path: 'a.txt', content: 'B' })
    await ctx.fileReview.keep(owner, change.id)
    session.append('session/title', { title: 'Review', source: { kind: 'user' }, messageSeqs: [] } as never)
    await ctx.sessions.flush(session)
    await close()
    await mount()
    expect((await ctx.fileReview.list(owner))[0]).toMatchObject({ id: change.id, state: 'kept', callId: change.callId })
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('rolledBack')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('A')
  })

  it('retains history after git add, commit and reset', async () => {
    const change = await call('write', { file_path: 'committed.txt', content: 'hello' })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' })
    git('init')
    git('add', '.')
    git('-c', 'user.name=Review Test', '-c', 'user.email=review@example.invalid', 'commit', '-m', 'record')
    git('reset', '--hard', 'HEAD')
    expect(git('diff').toString()).toBe('')
    expect((await ctx.fileReview.list(owner))[0]).toEqual(change)
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('rolledBack')
  })

  it('rejects wrong session, corrupt metadata and corrupt before bytes without touching the target', async () => {
    await writeFile(join(workspace, 'a.txt'), 'A')
    const change = await call('write', { file_path: 'a.txt', content: 'B' })
    await expect(ctx.fileReview.undo(SessionId('other'), change.id)).rejects.toThrow()
    await writeFile(snapshotPath(change.id, 'before'), 'corrupt')
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('corrupt')
    await writeFile(snapshotPath(change.id, 'meta.json'), JSON.stringify({ ...change, sessionId: 'other' }))
    await expect(ctx.fileReview.undo(owner, change.id)).rejects.toThrow('belong')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('B')
  })

  it('retains binary snapshots and marks over-limit overwrites unavailable', async () => {
    const binary = Buffer.from([0, 255, 12, 3])
    await writeFile(join(workspace, 'binary'), binary)
    const change = await call('write', { file_path: 'binary', content: 'text' })
    expect(change).toMatchObject({ binary: true, reversible: true, hunks: [] })
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('rolledBack')
    expect(await readFile(join(workspace, 'binary'))).toEqual(binary)
    await close()
    await mount(2)
    session = ctx.sessions.create(owner, { meta: { cwd: workspace } })
    const large = await call('write', { file_path: 'binary', content: 'text' })
    expect(large).toMatchObject({ reversible: false, truncated: true })
    expect((await ctx.fileReview.undo(owner, large.id)).status).toBe('unavailable')
  })

  it('keeps interrupted mutations unavailable and removes failed tool snapshots', async () => {
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('failed'), name: 'edit', arguments: { file_path: 'missing', old_string: 'a', new_string: 'b' }, agent: { session } as never })
    expect(result.isError).toBe(true)
    expect(await ctx.fileReview.list(owner)).toEqual([])
    const change = await call('write', { file_path: 'a.txt', content: 'B' })
    await writeFile(snapshotPath(change.id, 'meta.json'), JSON.stringify({ ...change, state: 'undoing' }))
    expect((await ctx.fileReview.undo(owner, change.id)).status).toBe('unavailable')
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('B')
    expect(await readdir(snapshotPath(change.id, '..'))).toContain(change.id)
  })
})
