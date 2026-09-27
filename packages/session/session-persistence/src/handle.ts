/** Per-session channel returned by the durable persistence service. */
import type { SessionEvent, SessionHeader, SessionId } from '@hydra1902/harness-session'

/** Access granted to a session handle. */
export type SessionAccess = 'read' | 'write'

/** Optional cancellation for handle reads. */
export interface SessionHandleReadOptions { readonly signal?: AbortSignal }
/** Optional cancellation for handle appends. */
export interface SessionHandleAppendOptions { readonly signal?: AbortSignal }
/** Optional cancellation for handle flushes. */
export interface SessionHandleFlushOptions { readonly signal?: AbortSignal }

/** Result of a handle read. The array is owned by the caller. */
export interface SessionHandleReadResult {
  readonly events: readonly SessionEvent[]
}

/** One single-owner channel onto a session's append-only log. */
export interface SessionHandle extends AsyncDisposable {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly access: SessionAccess
  read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult>
  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void>
  flush(options?: SessionHandleFlushOptions): Promise<void>
  close(): Promise<void>
}
