/** Pending state and visible failures for transcript navigation. */
import { useRef, useState } from 'react'
import type { SessionId, SessionVersionId } from '@hydraharness/harness-session/types'

/**
 * Serialize navigation from one version pager and preserve failures for its live region.
 * @param open - Host-backed transcript selection.
 * @returns Navigation callback, pending state, and the latest failure.
 */
export function useVersionNavigation(open: (id: SessionId | SessionVersionId) => void | Promise<void>): {
  pending: boolean
  error: string | null
  navigate(id: SessionId | SessionVersionId): Promise<void>
} {
  const lock = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = async (id: SessionId | SessionVersionId): Promise<void> => {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError(null)
    try { await open(id) } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { lock.current = false; setPending(false) }
  }
  return { pending, error, navigate }
}
