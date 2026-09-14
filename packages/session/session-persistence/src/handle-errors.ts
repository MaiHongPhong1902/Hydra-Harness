import type { SessionId } from '@hydra/harness-session'

/** A write open found another active writer for the same session. */
export class SessionAlreadyOwnedError extends Error {
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is already owned by an active write handle`)
    this.name = 'SessionAlreadyOwnedError'
  }
}

/** A handle operation was attempted after close. */
export class SessionHandleClosedError extends Error {
  constructor(readonly sessionId: SessionId, operation: string) {
    super(`session "${sessionId}": ${operation} on a closed handle`)
    this.name = 'SessionHandleClosedError'
  }
}

/** A mutating operation was attempted on a read handle. */
export class SessionReadOnlyError extends Error {
  constructor(readonly sessionId: SessionId, operation: string) {
    super(`session "${sessionId}": ${operation} is not available on a read handle`)
    this.name = 'SessionReadOnlyError'
  }
}

/** A write handle lost its ownership and must be closed before reopening. */
export class SessionOwnershipLostError extends Error {
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}": write ownership was lost; close this handle and reopen`)
    this.name = 'SessionOwnershipLostError'
  }
}
