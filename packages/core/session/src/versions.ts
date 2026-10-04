/** Session-local transcript paths over immutable event references. */
import { ORIGINAL_SESSION_VERSION } from './types.ts'
import type { SessionEvent, SessionVersionId } from './types.ts'

interface Link { readonly event: SessionEvent; readonly previous: Link | undefined }

/** Read access to a session-owned version index; mutations enter through the session log. */
export interface SessionVersions {
  /** Selected transcript identity. */
  readonly current: SessionVersionId
  /** Changes whenever the selected transcript prefix changes. */
  readonly generation: number
  /** Stored transcript identities in creation order. */
  readonly ids: readonly SessionVersionId[]
  /**
   * Read one stored transcript using the original immutable event objects.
   * @param versionId - Stored path; omitted for the selected path.
   * @returns Immutable ordered event references.
   */
  events(versionId?: SessionVersionId): readonly SessionEvent[]
}

/**
 * Incremental version index; each accepted event has one link, and shared prefixes reuse links.
 * Only the currently requested transcript array is cached.
 */
export class SessionVersionIndex implements SessionVersions {
  private readonly heads = new Map<SessionVersionId, Link | undefined>([[ORIGINAL_SESSION_VERSION, undefined]])
  private selected = ORIGINAL_SESSION_VERSION
  private lastSeq = -1
  private snapshot: readonly SessionEvent[] | undefined
  private epoch = 0

  /** Current transcript path. */
  get current(): SessionVersionId { return this.selected }
  /** Changes whenever the selected prefix changes, including creation of a new version. */
  get generation(): number { return this.epoch }
  /** Stored version identifiers in creation order. */
  get ids(): readonly SessionVersionId[] { return [...this.heads.keys()] }

  /**
   * Validate an event without publishing any version state.
   * @param event - Next event in the complete session log.
   */
  validate(event: SessionEvent): void {
    if (event.seq !== this.lastSeq + 1) throw new Error(`session event seq ${event.seq} is not contiguous; expected ${this.lastSeq + 1}`)
    if (event.type === 'session/version') {
      const { versionId, parentVersionId, beforeSeq } = event.data
      if (typeof versionId !== 'string' || versionId.length === 0 || this.heads.has(versionId)) throw new Error('session version identifier must be new')
      if (!this.heads.has(parentVersionId)) throw new Error('session version parent does not exist')
      if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || beforeSeq > event.seq) throw new Error('session version prefix must precede creation')
      if (beforeSeq > 0 && beforeSeq < event.seq && !this.contains(parentVersionId, beforeSeq)) throw new Error('session version prefix is outside its parent transcript')
    } else if (event.type === 'session/version-selected' && !this.heads.has(event.data.versionId)) {
      throw new Error('selected session version does not exist')
    }
  }

  /**
   * Accept the next event after validation; log-only selection records never enter a transcript.
   * @param event - Contiguous immutable session event.
   */
  append(event: SessionEvent): void {
    this.validate(event)
    if (event.type === 'session/version') {
      let head = this.heads.get(event.data.parentVersionId)
      while (head !== undefined && head.event.seq >= event.data.beforeSeq) head = head.previous
      this.heads.set(event.data.versionId, head)
      this.selected = event.data.versionId
      this.epoch++
    } else if (event.type === 'session/version-selected') {
      this.selected = event.data.versionId
      this.epoch++
    } else {
      this.heads.set(this.selected, { event, previous: this.heads.get(this.selected) })
    }
    this.lastSeq = event.seq
    this.snapshot = undefined
  }

  private contains(version: SessionVersionId, seq: number): boolean {
    let head = this.heads.get(version)
    while (head !== undefined && head.event.seq > seq) head = head.previous
    return head?.event.seq === seq
  }

  /**
   * Read one stored path using original event sequences and object references.
   * @param versionId - Stored path; omitted for the selected path.
   * @returns Immutable transcript; no prompt or response payload is cloned.
   */
  events(versionId: SessionVersionId = this.selected): readonly SessionEvent[] {
    if (!this.heads.has(versionId)) throw new Error('session version does not exist')
    if (versionId === this.selected && this.snapshot !== undefined) return this.snapshot
    const events: SessionEvent[] = []
    let head = this.heads.get(versionId)
    while (head !== undefined) { events.push(head.event); head = head.previous }
    const result = Object.freeze(events.reverse())
    if (versionId === this.selected) this.snapshot = result
    return result
  }
}

/**
 * Reconstruct session-local versions from a complete durable log.
 * @param events - Complete contiguous log.
 * @returns Version index sharing the supplied immutable event payloads.
 */
export function sessionVersions(events: readonly SessionEvent[]): SessionVersionIndex {
  const index = new SessionVersionIndex()
  for (const event of events) index.append(event)
  return index
}
