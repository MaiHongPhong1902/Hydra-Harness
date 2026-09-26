/** Shared per-session review object; disk-backed host records own all business data. @module */
import type { IApiClient, SessionId } from '@hydra1902/harness-api-remotes/client'
import type { ChangeId, ReviewChange } from '@hydra1902/harness-fs-review/client'
import type { ReviewMode, WorkspaceReview } from '@hydra1902/harness-fs-review/client'

/** Immutable UI read face for one owning session and its subagents. */
export interface ReviewSnapshot {
  changes: readonly ReviewChange[]
  pending: ReadonlySet<ChangeId>
  loading: boolean
  error: string | null
  workspace: WorkspaceReview | null
  workspaceLoading: boolean
  workspaceError: string | null
}

/** Shared data source used by the Review tab and every inline tool entry. */
export class ReviewHistory {
  private snapshot: ReviewSnapshot = {
    changes: [], pending: new Set(), loading: true, error: null, workspace: null, workspaceLoading: true, workspaceError: null,
  }
  private readonly listeners = new Set<() => void>()
  private request: Promise<void> | undefined
  private workspaceRequest = 0
  private workspaceQuery: { mode: ReviewMode; ref?: string; fullContext: boolean } | undefined
  private dirty = false
  private closed = false

  constructor(
    readonly sessionId: SessionId,
    private readonly api: Pick<IApiClient['review'], 'list' | 'keep' | 'undo'>
      & Partial<Pick<IApiClient['review'], 'workspace'>>,
  ) {}

  /** Read the stable snapshot until a completed operation publishes a replacement. */
  getSnapshot = (): ReviewSnapshot => this.snapshot

  /** Subscribe to this history; the first consumer starts its initial read. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.snapshot.loading) void this.refresh()
    return () => { this.listeners.delete(listener) }
  }

  /** Read the current Git comparison from the owning session workspace. */
  refreshWorkspace = async (mode?: ReviewMode, ref?: string, fullContext = false): Promise<void> => {
    if (this.closed) return
    if (this.api.workspace === undefined) {
      this.publish({ workspaceLoading: false, workspaceError: 'Workspace review is unavailable on this host.' })
      return
    }
    this.workspaceQuery = mode === undefined ? this.workspaceQuery ?? { mode: 'uncommitted', fullContext }
      : { mode, ...(ref === undefined ? {} : { ref }), fullContext }
    const request = ++this.workspaceRequest
    this.publish({ workspaceLoading: true, workspaceError: null })
    try {
      const response = await this.api.workspace({ sessionId: this.sessionId, ...this.workspaceQuery })
      if (!response.result.ok) throw new Error(response.result.error.message)
      if (request === this.workspaceRequest) {
        this.publish({ workspace: response.result.value, workspaceLoading: false, workspaceError: null })
      }
    } catch (error: unknown) {
      if (request === this.workspaceRequest) {
        this.publish({ workspaceLoading: false, workspaceError: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  private publish(update: Partial<ReviewSnapshot>): void {
    if (this.closed) return
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }

  /** Refetch after a committed Host change; overlapping notifications coalesce. */
  refresh = (): Promise<void> => {
    if (this.workspaceQuery !== undefined) void this.refreshWorkspace()
    this.dirty = true
    this.request ??= (async () => {
      while (this.dirty && !this.closed) {
        this.dirty = false
        try {
          const response = await this.api.list({ sessionId: this.sessionId, includeChildren: true })
          if (!response.result.ok) throw new Error(response.result.error.message)
          this.publish({ changes: response.result.value.changes, loading: false, error: null })
        } catch (error: unknown) {
          this.publish({ error: error instanceof Error ? error.message : String(error), loading: false })
        }
      }
    })().finally(() => { this.request = undefined })
    return this.request
  }

  /**
   * Perform one exact owning-session action and refresh after acknowledgement.
   * @param change - stored evidence identifying the change and session.
   * @param action - Keep marks reviewed; Undo requests hash-guarded restoration.
   * @returns whether the action completed; batches stop on conflict or failure.
   */
  act = async (change: ReviewChange, action: 'keep' | 'undo'): Promise<boolean> => {
    if (this.snapshot.pending.has(change.id)) return false
    this.publish({ pending: new Set([...this.snapshot.pending, change.id]), error: null })
    try {
      const response = await this.api[action]({ sessionId: change.sessionId, changeId: change.id })
      if (!response.result.ok) throw new Error(response.result.error.message)
      const { status } = response.result.value
      await this.refresh()
      if (status === 'conflict') this.publish({ error: `${change.path}: the file changed after this edit. Undo was skipped.` })
      if (status === 'unavailable') this.publish({ error: `${change.path}: Undo is unavailable for this snapshot.` })
      return status !== 'conflict' && status !== 'unavailable'
    } catch (error: unknown) {
      this.publish({ error: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      this.publish({ pending: new Set([...this.snapshot.pending].filter(id => id !== change.id)) })
    }
  }

  /** Stop publication when the owning plugin unloads. */
  dispose(): void { this.closed = true; this.listeners.clear() }
}
