/** Bounded JSON reads for native account authentication and catalogs. */
import { LlmError } from '@hydraharness/harness-llm'

/**
 * Read one provider JSON object within the account protocol's byte limit.
 * @param response - provider response owned by this operation.
 * @param signal - cancellation of the whole account operation.
 * @returns the decoded object; malformed or oversized replies fail without their body in diagnostics.
 */
export async function accountJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (response.body === null) throw new LlmError('Account provider returned an empty JSON response.', 'MALFORMED_RESPONSE')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = (): void => { void reader.cancel().catch(() => { /* Abort can race a completed response. */ }) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) break
      size += next.value.byteLength
      if (size > 1024 * 1024) throw new LlmError('Account provider returned an oversized JSON response.', 'MALFORMED_RESPONSE')
      chunks.push(next.value)
    }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new LlmError('Account provider returned invalid JSON.', 'MALFORMED_RESPONSE') }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LlmError('Account provider returned a non-object JSON response.', 'MALFORMED_RESPONSE')
    return value as Record<string, unknown>
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => { /* Read failure or abort may already have closed the response. */ })
    reader.releaseLock()
  }
}
