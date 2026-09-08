/** Agent-owned snapshots and hash-guarded review actions over the filesystem provider. @module */
import { Context, Service } from '@hydra/cordis'
import z from '@hydra/schemastery'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { writeFileAtomic, withFileLock } from '@hydra/harness-atomic-write'
import { resolveHydraHome } from '@hydra/harness-home-paths'
import type { ToolDispatchExecution } from '@hydra/harness-tools'
import { FsError, type FsTarget } from '@hydra/harness-fs'
import type { SessionId } from '@hydra/harness-session'
import type {} from '@hydra/harness-session-persistence'
import { effectiveSandboxMode } from '@hydra/harness-sandbox-policy'
import { reviewChangeSchema } from './client.ts'
import { preview, type ReviewLimits } from './diff.ts'
import type { ChangeId, ReviewChange, ReviewOutcome } from './types.ts'
export type { ChangeId, ReviewChange, ReviewOutcome } from './types.ts'

declare module '@hydra/cordis' {
  interface Context { fileReview: FileReview }
}

/** Snapshot location and inclusive resource limits. */
export interface Config extends Partial<ReviewLimits> {
  /** Defaults to the review-changes directory in the Hydra home, outside workspaces. */
  directory?: string
}

/** Durable review service; records are scoped by exact session and random change id. */
export class FileReview extends Service {
  static inject = ['fs', 'tools', 'sessions', 'sessionPersistence']
  static Config: z<Config> = z.object({
    directory: z.string().default(join(resolveHydraHome(), 'review-changes')),
    snapshotMaxBytes: z.number().step(1).min(1).default(16 * 1024 * 1024),
    diffMaxBytes: z.number().step(1).min(1).default(512 * 1024),
    diffMaxLines: z.number().step(1).min(1).default(4000),
    diffMaxCells: z.number().step(1).min(1).default(2_000_000),
  })
  private readonly executions = new AsyncLocalStorage<ToolDispatchExecution>()
  /** Schema-resolved storage location and resource limits. */
  readonly config: Required<Config>

  constructor(ctx: Context, options: Config) {
    super(ctx, 'fileReview')
    const config = this.config = {
      directory: options.directory ?? join(resolveHydraHome(), 'review-changes'),
      snapshotMaxBytes: options.snapshotMaxBytes ?? 16 * 1024 * 1024,
      diffMaxBytes: options.diffMaxBytes ?? 512 * 1024,
      diffMaxLines: options.diffMaxLines ?? 4000,
      diffMaxCells: options.diffMaxCells ?? 2_000_000,
    }
    if (!isAbsolute(config.directory)) throw new Error('file-review directory must be absolute')
    ctx.effect(async function* (this: FileReview) { await this.sweep() }.bind(this))
    ctx.on('tools/execute', (exec, next) => this.executions.run(exec, next))
    ctx.on('fs/mutate', async (target, operation, next) => {
      const exec = this.executions.getStore()
      const session = exec?.agent?.session
      if (!exec || !session?.header.cwd || !['write', 'edit'].includes(exec.name)) return next()
      const root = await ctx.fs.resolve(session.header.cwd)
      if (!ctx.fs.contains(root, target) || root.targetKey === target.targetKey) return next()
      const storage = await ctx.fs.resolve(config.directory)
      if (ctx.fs.contains(root, storage)) throw new Error('review snapshots must be stored outside the workspace')
      const before = await ctx.fs.snapshot(target, config.snapshotMaxBytes)
      const id = randomUUID() as ChangeId
      const dir = this.changeDir(session.id, id)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      if (before.bytes) {
        const file = await open(join(dir, 'before'), 'wx', 0o600)
        try { await file.writeFile(before.bytes); await file.sync() } finally { await file.close() }
      }
      const change: ReviewChange = {
        version: 1, id, sessionId: session.id, callId: exec.callId, rootCallId: exec.rootCallId,
        toolName: exec.name, seq: session.seq,
        turnSeq: session.events.findLast(e => e.type === 'turn/start')?.seq ?? null,
        stepSeq: session.events.findLast(e => e.type === 'step/start')?.seq ?? null,
        parentSessionId: session.header.origin === 'subagent' ? session.header.parentSession ?? null : null,
        agentPreset: session.header.agentPreset ?? null, createdAt: Date.now(),
        workspace: ctx.fs.processPath(root), path: relative(ctx.fs.processPath(root), ctx.fs.processPath(target)).split(sep).join('/'),
        operation, status: before.hash === null ? 'added' : 'modified', state: 'pending',
        beforeHash: before.hash, afterHash: null, reversible: false,
        binary: false, truncated: true, additions: 0, deletions: 0, hunks: [],
      }
      await this.save(change)
      let result
      try { result = await next() } catch (error: unknown) {
        // A provider can fail after publication. Only discard evidence of an unchanged file.
        if ((await ctx.fs.snapshot(target, 0)).hash === before.hash) await rm(dir, { recursive: true, force: true })
        throw error
      }
      const after = await ctx.fs.snapshot(target, config.diffMaxBytes)
      Object.assign(change, {
        afterHash: after.hash, state: 'active',
        status: after.hash === null ? 'deleted' : change.status,
        reversible: before.hash === null ? after.hash !== null : before.bytes !== null,
        ...preview(before.hash === null ? new Uint8Array() : before.bytes, after.hash === null ? new Uint8Array() : after.bytes, config),
      })
      await this.save(change)
      return result
    })
  }

  private sessionDir(id: SessionId): string {
    return join(this.config.directory, createHash('sha256').update(id).digest('hex'))
  }

  private changeDir(sessionId: SessionId, id: ChangeId): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid review change id')
    return join(this.sessionDir(sessionId), id)
  }

  private async save(change: ReviewChange): Promise<void> {
    const meta = join(this.changeDir(change.sessionId, change.id), 'meta.json')
    await withFileLock(meta, () => this.saveUnlocked(change, meta))
    this.ctx.emit('file-review/changed', change.sessionId)
  }

  private async saveUnlocked(change: ReviewChange, meta: string): Promise<void> {
    await writeFileAtomic(meta, JSON.stringify(reviewChangeSchema.parse(change)), { mode: 0o600, dirMode: 0o700 })
  }

  private async read(sessionId: SessionId, id: ChangeId): Promise<ReviewChange> {
    const meta = join(this.changeDir(sessionId, id), 'meta.json')
    return withFileLock(meta, () => this.readUnlocked(sessionId, id, meta))
  }

  private async readUnlocked(sessionId: SessionId, id: ChangeId, meta: string): Promise<ReviewChange> {
    const change = reviewChangeSchema.parse(JSON.parse(await readFile(meta, 'utf8')))
    if (change.sessionId !== sessionId || change.id !== id) throw new Error('review change does not belong to this session')
    return change
  }

  /**
   * Read chronological snapshot history without consulting Git or current file contents.
   * @param sessionId - exact owner; forks do not inherit mutation authority.
   * @returns every committed record, including unavailable interrupted operations.
   */
  async list(sessionId: SessionId): Promise<ReviewChange[]> {
    let entries
    try { entries = await readdir(this.sessionDir(sessionId), { withFileTypes: true }) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records = await Promise.all(entries.filter(e => e.isDirectory()).map(async (e) => {
      try {
        return await this.read(sessionId, e.name as ChangeId)
      } catch (error: unknown) {
        // A mutation creates its change directory before its record commits, and a
        // failed one removes the directory again: ENOENT is that uncommitted record.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    }))
    return records.filter((record): record is ReviewChange => record !== undefined)
      .sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  /**
   * Mark a change kept, retaining its evidence and ability to undo.
   * @param sessionId - owning session id.
   * @param id - exact change id.
   * @returns the committed review state.
   */
  async keep(sessionId: SessionId, id: ChangeId): Promise<ReviewOutcome> {
    return this.act(sessionId, id, false)
  }

  /**
   * Undo only the recorded post-edit state; verifies snapshot integrity before writing.
   * @param sessionId - owning session id.
   * @param id - exact change id.
   * @returns success, conflict, or unavailable; unavailable/uncertain records never write.
   */
  async undo(sessionId: SessionId, id: ChangeId): Promise<ReviewOutcome> {
    return this.act(sessionId, id, true)
  }

  private async act(sessionId: SessionId, id: ChangeId, undo: boolean): Promise<ReviewOutcome> {
    const meta = join(this.changeDir(sessionId, id), 'meta.json')
    return withFileLock(meta, async () => {
      const change = await this.readUnlocked(sessionId, id, meta)
      if (change.state === 'rolledBack') return { status: 'alreadyRolledBack', change }
      if (change.state === 'pending' || change.state === 'undoing') return { status: 'unavailable', change }
      const { meta: header, events } = await this.ctx.sessionPersistence.inspect(sessionId)
      const root = header.cwd === undefined ? undefined : await this.ctx.fs.resolve(header.cwd)
      if (!root || this.ctx.fs.processPath(root) !== change.workspace) throw new Error('review workspace does not match its session')
      if (!undo) {
        change.state = 'kept'
        await this.saveUnlocked(change, meta)
        this.ctx.emit('file-review/changed', change.sessionId)
        return { status: 'kept', change }
      }
      if (!change.reversible) return { status: 'unavailable', change }
      const target: FsTarget = await this.ctx.fs.resolve(change.path, { cwd: change.workspace })
      if (!this.ctx.fs.contains(root, target) || root.targetKey === target.targetKey
        || relative(change.workspace, this.ctx.fs.processPath(target)).split(sep).join('/') !== change.path) {
        throw new Error('review path changed or escaped its workspace')
      }
      let bytes: Buffer | null = null
      if (change.beforeHash !== null) {
        const snapshot = await open(join(this.changeDir(sessionId, id), 'before'), 'r')
        try {
          const info = await snapshot.stat()
          if (!info.isFile() || info.size > this.config.snapshotMaxBytes) throw new Error('review snapshot exceeds size limit or is not a regular file')
          const size = info.size
          const buffer = Buffer.alloc(size + 1)
          let length = 0
          while (length < buffer.length) {
            const { bytesRead } = await snapshot.read(buffer, length, buffer.length - length, null)
            if (bytesRead === 0) break
            length += bytesRead
          }
          if (length !== size) throw new Error('review snapshot changed while reading')
          bytes = buffer.subarray(0, size)
        } finally { await snapshot.close() }
        if (createHash('sha256').update(bytes).digest('hex') !== change.beforeHash) throw new Error('review snapshot is corrupt')
      }
      const priorState = change.state
      change.state = 'undoing'
      await this.saveUnlocked(change, meta)
      this.ctx.emit('file-review/changed', change.sessionId)
      const policyService = this.ctx.get('sandboxPolicy')
      const policy = policyService === undefined ? undefined : {
        mode: effectiveSandboxMode(events) ?? policyService.defaultMode,
        workspaceRoot: change.workspace,
      }
      // Failure may follow publication; retain the uncertain marker for inspection.
      let restored: boolean
      try {
        restored = await this.ctx.fs.restoreSnapshot(target, bytes, change.afterHash, policy)
      } catch (error: unknown) {
        if (error instanceof FsError && error.code === 'FS_SANDBOX_DENIED') {
          change.state = priorState
          await this.saveUnlocked(change, meta)
          this.ctx.emit('file-review/changed', change.sessionId)
        }
        throw error
      }
      change.state = restored ? 'rolledBack' : priorState
      await this.saveUnlocked(change, meta)
      this.ctx.emit('file-review/changed', change.sessionId)
      return { status: restored ? 'rolledBack' : 'conflict', change }
    })
  }

  /**
   * Remove orphan session directories; surviving sessions retain all review evidence.
   * @returns completion after stale directories are removed; never restores workspace files.
   */
  async sweep(): Promise<void> {
    let entries
    try { entries = await readdir(this.config.directory, { withFileTypes: true }) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const live = new Set((await this.ctx.sessionPersistence.list()).map(h => this.sessionDir(h.id)))
    for (const session of this.ctx.sessions.list()) live.add(this.sessionDir(session.id))
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
      const path = join(this.config.directory, entry.name)
      if (!live.has(path)) await rm(path, { recursive: true, force: true })
    }
  }
}

export default FileReview
