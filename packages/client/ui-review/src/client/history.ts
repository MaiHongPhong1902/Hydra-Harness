/** Shared per-session review object; disk-backed host records own all business data. @module */
import type { IApiClient, SessionId } from '@hydra/harness-api-remotes/client'
import type { ChangeId, ReviewChange } from '@hydra/harness-fs-review/client'

/** Immutable UI read face for one owning session and its subagents. */
export interface ReviewSnapshot {
  changes: readonly ReviewChange[]
  pending: ReadonlySet<ChangeId>
  loading: boolean
  error: string | null
}

/** Shared data source used by the Review tab and every inline tool entry. */
export class ReviewHistory {
  private snapshot: ReviewSnapshot = { changes: [], pending: new Set(), loading: true, error: null }
  private readonly listeners = new Set<() => void>()
  private request: Promise<void> | undefined
  private dirty = false
  private closed = false

  constructor(readonly sessionId: SessionId, private readonly api: IApiClient['review']) {}

  /** Read the stable snapshot until a completed operation publishes a replacement. */
  getSnapshot = (): ReviewSnapshot => this.snapshot

  /** Subscribe to this history; the first consumer starts its initial read. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.snapshot.loading) void this.refresh()
    return () => { this.listeners.delete(listener) }
  }

  private publish(update: Partial<ReviewSnapshot>): void {
    if (this.closed) return
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }

  /** Refetch after a committed Host change; overlapping notifications coalesce. */
  refresh = (): Promise<void> => {
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
   */
  act = async (change: ReviewChange, action: 'keep' | 'undo'): Promise<void> => {
    if (this.snapshot.pending.has(change.id)) return
    this.publish({ pending: new Set([...this.snapshot.pending, change.id]), error: null })
    try {
      const response = await this.api[action]({ sessionId: change.sessionId, changeId: change.id })
      if (!response.result.ok) throw new Error(response.result.error.message)
      const { status } = response.result.value
      await this.refresh()
      if (status === 'conflict') this.publish({ error: `${change.path}: the file changed after this edit. Undo was skipped.` })
      if (status === 'unavailable') this.publish({ error: `${change.path}: Undo is unavailable for this snapshot.` })
    } catch (error: unknown) {
      this.publish({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.publish({ pending: new Set([...this.snapshot.pending].filter(id => id !== change.id)) })
    }
  }

  /** Stop publication when the owning plugin unloads. */
  dispose(): void { this.closed = true; this.listeners.clear() }
}
