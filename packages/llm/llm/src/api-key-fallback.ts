/** Request-local key selection shared by adapters and agent request recovery. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { GenerateOptions, StreamChunk } from './types.ts'
import { normalizeLlmFailure } from './adapter-failure.ts'

/** Key positions only; credentials never enter recovery state or session events. */
export interface ApiKeyAttempt {
  /** Zero-based key selected for the next provider attempt. */
  index: number
  /** Number of keys in the serving adapter snapshot. */
  count: number
}

const attempts = new AsyncLocalStorage<ApiKeyAttempt | undefined>()

/**
 * Run one iterator operation under an agent's request-local key selection.
 * @param attempt - mutable positions owned by this agent request.
 * @param operation - iterator operation, including its asynchronous work.
 * @returns the operation's result.
 */
export function withApiKeyAttempt<T>(attempt: ApiKeyAttempt | undefined, operation: () => T): T {
  return attempts.run(attempt, operation)
}

/**
 * Dispatch ordered keys without mixing partial responses. Agent recovery owns
 * streamed retries; direct calls with several keys buffer one attempt at a time.
 * @param options - request and caller cancellation.
 * @param count - positive number of credential choices, including native auth.
 * @param stream - one attempt using the selected key position.
 * @returns one response, or the last failure after all choices fail.
 */
export async function* streamWithApiKeys(
  options: GenerateOptions,
  count: number,
  stream: (index: number) => AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  const attempt = attempts.getStore()
  if (attempt !== undefined) {
    attempt.count = count
    attempt.index = Math.min(attempt.index, count - 1)
    yield* stream(attempt.index)
    return
  }
  if (count === 1) {
    yield* stream(0)
    return
  }
  for (let index = 0; index < count; index++) {
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Model request canceled' } } }
      return
    }
    const chunks: StreamChunk[] = []
    let failed = false
    let aborted = false
    try {
      for await (const chunk of stream(index)) {
        options.signal?.throwIfAborted()
        chunks.push(chunk)
        if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'aborted') { aborted = true; break }
          failed = chunk.reason.kind === 'error'
        }
      }
    } catch (error: unknown) {
      if (options.signal?.aborted || normalizeLlmFailure(error).code === 'ABORTED' || index === count - 1) throw error
      continue
    }
    if (aborted || !failed || index === count - 1) {
      yield* chunks
      return
    }
  }
}
